import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { nextTemplateMenuIndex } from '../hooks/useTemplateImportMenu';
import { AppComposerDockStatus, TemplateUploadBar } from './AppComposerDock';
import { Button } from './ui/Button';

function collectByType(node: ReactNode, type: unknown): ReactElement<Record<string, any>>[] {
  const matches: ReactElement<Record<string, any>>[] = [];
  const visit = (value: ReactNode) => {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === type) {
        matches.push(child as ReactElement<Record<string, any>>);
      }
      visit((child.props as { children?: ReactNode }).children);
    });
  };
  visit(node);
  return matches;
}

describe('AppComposerDockStatus', () => {
  it('renders stop and selected recipe actions through Button primitives', () => {
    const html = renderToStaticMarkup(
      <AppComposerDockStatus
        selectedRecipe={{ id: 'r1', name: '周报' }}
        streamingId="run-1"
        onClearRecipe={() => {}}
        onStopStreaming={() => {}}
      />,
    );

    expect(html.match(/class="ui-btn /g)?.length).toBe(2);
    expect(html).toContain('stop-btn');
    expect(html).toContain('■ 停止生成');
    expect(html).toContain('模板：周报');
    expect(html).toContain('>清除</button>');
  });

  it('keeps stop and clear callbacks wired', () => {
    const onClearRecipe = vi.fn();
    const onStopStreaming = vi.fn();
    const buttons = collectByType(
      AppComposerDockStatus({
        selectedRecipe: { id: 'r1', name: '周报' },
        streamingId: 'run-1',
        onClearRecipe,
        onStopStreaming,
      }),
      Button,
    );

    expect(buttons).toHaveLength(2);
    buttons[0]!.props.onClick();
    buttons[1]!.props.onClick();
    expect(onStopStreaming).toHaveBeenCalledOnce();
    expect(onClearRecipe).toHaveBeenCalledOnce();
  });

  it('offers task and layout templates from one beginner-facing import entry', () => {
    const html = renderToStaticMarkup(
      <TemplateUploadBar
        onUploadTemplates={async () => []}
        onUploadLayoutTemplates={() => {}}
      />,
    );

    expect(html).toContain('导入模板');
    expect(html).toContain('任务流程模板');
    expect(html).toContain('Office / 网页版式');
    expect(html).toContain('可导入任务步骤，也可上传 Word / Excel / PPT / 网页模板');
    expect(html.match(/class="template-upload-input"/g)?.length).toBe(2);
    expect(html).toContain('accept=".json,application/json"');
    expect(html).toContain('multiple=""');
    expect(html).toContain('aria-label="上传任务模板文件"');
    expect(html).toContain('accept=".docx,.xlsx,.pptx,.html,.htm"');
    expect(html).toContain('aria-label="上传版式模板文件"');
    expect(html).not.toContain('支持批量 JSON 模板');
  });

  it('exposes menu-button semantics and deterministic keyboard navigation', () => {
    const html = renderToStaticMarkup(
      <TemplateUploadBar onUploadTemplates={async () => []} onUploadLayoutTemplates={() => {}} />,
    );

    expect(html).toContain('aria-controls="template-import-menu"');
    expect(html).toContain('id="template-import-menu"');
    expect(nextTemplateMenuIndex('ArrowDown', 0, 2)).toBe(1);
    expect(nextTemplateMenuIndex('ArrowDown', 1, 2)).toBe(0);
    expect(nextTemplateMenuIndex('ArrowUp', 0, 2)).toBe(1);
    expect(nextTemplateMenuIndex('Home', 1, 2)).toBe(0);
    expect(nextTemplateMenuIndex('End', 0, 2)).toBe(1);
    expect(nextTemplateMenuIndex('Enter', 1, 2)).toBeNull();
  });
});
