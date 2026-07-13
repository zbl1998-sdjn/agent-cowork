import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { OfficeEditorSession } from '../../lib/api';
import type { WebComponentNode, WebElementSelection } from '../../lib/types/webEditor';
import { sanitizeImportedWebSource, WebPageCanvas } from './WebPageCanvas';
import { WebComponentTree } from './WebComponentTree';
import { selectionPatchFromDraft, WebEditorInspector } from './WebEditorInspector';
import { supportsOnlyOffice } from '../../lib/api';
import { defaultEditedCopyName, OfficeFormatCanvas, supportsVisualEditing } from './OfficeVisualEditor';

const docxSession: OfficeEditorSession = {
  kind: 'docx',
  name: 'report.docx',
  revisionSha256: 'a'.repeat(64),
  sections: [{
    id: 'document',
    label: '文档正文',
    nodes: [
      { id: 'paragraph:0', type: 'paragraph', text: '项目周报' },
      { id: 'paragraph:1', type: 'paragraph', text: '本周进展' },
    ],
  }],
};

describe('Office visual editor', () => {
  it('recognises supported formats and proposes a non-destructive copy name', () => {
    expect(supportsVisualEditing('report.docx')).toBe(true);
    expect(supportsVisualEditing('table.xlsx')).toBe(true);
    expect(supportsVisualEditing('deck.pptx')).toBe(true);
    expect(supportsVisualEditing('page.html')).toBe(true);
    expect(supportsVisualEditing('report.pdf')).toBe(false);
    expect(defaultEditedCopyName('report.docx')).toBe('report-可视化编辑.docx');
    expect(supportsOnlyOffice('report.docx')).toBe(true);
    expect(supportsOnlyOffice('page.html')).toBe(false);
  });

  it('renders selectable document objects with the live draft text', () => {
    const html = renderToStaticMarkup(
      <OfficeFormatCanvas
        session={docxSession}
        activeSectionId="document"
        selectedId="paragraph:1"
        drafts={{ 'paragraph:1': '本周进展（已更新）' }}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('项目周报');
    expect(html).toContain('本周进展（已更新）');
    expect(html).toContain('is-selected');
  });

  it('uses a fixed isolated frame for real web component selection', () => {
    const source = sanitizeImportedWebSource('<main><h1>标题</h1></main>');
    expect(source).toContain('<h1>标题</h1>');
    const html = renderToStaticMarkup(
      <WebPageCanvas source="<main><h1>标题</h1></main>" onSelection={() => {}} onSnapshot={() => {}} />,
    );
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('src="/office-web-frame.html"');
    expect(html).not.toContain('srcDoc=');
    expect(html).toContain('网页实时画布');
    expect(html).toContain('桌面');
    expect(html).toContain('平板');
    expect(html).toContain('手机');
  });

  it('removes executable markup from imported web pages before adding the trusted bridge', () => {
    const source = sanitizeImportedWebSource(
      '<!doctype html><html><head><base href="https://example.com"><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><button onclick="alert(1)">体验</button><script>window.evil = true</script></body></html>',
    );

    expect(source).not.toContain('window.evil');
    expect(source).not.toContain('onclick=');
    expect(source).not.toContain('<base');
    expect(source).not.toContain('Content-Security-Policy');
  });

  it('removes unquoted executable URL attributes before the page reaches the sandbox', () => {
    const source = sanitizeImportedWebSource('<img src=javascript:alert(1)><a href=vbscript:msgbox(1)>危险链接</a>');

    expect(source).not.toMatch(/src\s*=\s*javascript:/i);
    expect(source).not.toMatch(/href\s*=\s*vbscript:/i);
  });

  it('renders a component hierarchy with a stable selected node', () => {
    const nodes: WebComponentNode[] = [
      { id: 'web-1', parentId: null, tag: 'main', label: '主内容', depth: 0, childCount: 1 },
      { id: 'web-2', parentId: 'web-1', tag: 'h1', label: '季度报告', depth: 1, childCount: 0 },
    ];
    const html = renderToStaticMarkup(<WebComponentTree nodes={nodes} selectedId="web-2" onSelect={() => {}} />);

    expect(html).toContain('页面结构');
    expect(html).toContain('季度报告');
    expect(html).toContain('aria-current="true"');
  });

  it('offers structural, responsive style and element attribute controls', () => {
    const selection: WebElementSelection = {
      id: 'web-2', tag: 'a', label: '查看详情', text: '查看详情', canEditText: true,
      color: 'rgb(23, 32, 51)', backgroundColor: 'rgb(255, 255, 255)', fontSize: '16px', textAlign: 'left',
      width: '120px', height: '40px', padding: '8px 12px', margin: '0px', borderRadius: '6px', border: '0px none rgb(23, 32, 51)',
      display: 'inline-flex', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: '0px',
      href: '/details', src: '', alt: '', target: '_self', className: 'cta',
    };
    const html = renderToStaticMarkup(
      <WebEditorInspector selection={selection} onUpdate={() => {}} onAction={() => {}} onInsert={() => {}} />,
    );

    expect(html).toContain('尺寸与间距');
    expect(html).toContain('链接地址');
    expect(html).toContain('复制组件');
    expect(html).toContain('双栏布局');
  });

  it('commits the latest drafted style value instead of the previous selection snapshot', () => {
    const selection: WebElementSelection = {
      id: 'web-2', tag: 'div', label: '内容区', text: '内容区', canEditText: true,
      color: 'rgb(23, 32, 51)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '16px', textAlign: 'start',
      width: '120px', height: '40px', padding: '8px', margin: '0px', borderRadius: '6px', border: '0px none rgb(23, 32, 51)',
      display: 'block', flexDirection: 'row', justifyContent: 'normal', alignItems: 'normal', gap: 'normal',
      href: '', src: '', alt: '', target: '', className: '',
    };
    const draft = { ...selection, width: '180px' };

    expect(selectionPatchFromDraft(selection, draft, 'width')).toEqual({ width: '180px' });
    expect(selectionPatchFromDraft(selection, selection, 'width')).toBeNull();
  });
});
