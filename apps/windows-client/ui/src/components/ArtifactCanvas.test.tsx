import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactCanvas } from './ArtifactCanvas';

describe('ArtifactCanvas', () => {
  it('shows an honest empty canvas before an artifact exists', () => {
    const html = renderToStaticMarkup(<ArtifactCanvas artifactId={null} text="" streaming={false} onApplyText={vi.fn()} onRequestRevision={vi.fn()} />);
    expect(html).toContain('成果会在这里逐步出现');
    expect(html).not.toContain('workbench-doc-page');
  });

  it('renders generated content as selectable blocks and exposes canvas actions', () => {
    const node = <ArtifactCanvas artifactId="m1" text={'# 周报\n\n已完成首版。'} streaming={false} onApplyText={vi.fn()} onRequestRevision={vi.fn()} onCollapse={vi.fn()} />;
    const html = renderToStaticMarkup(node);
    expect(html).toContain('成果画布');
    expect(html).toContain('周报');
    expect(html).toContain('已完成首版。');
    expect(html).toContain('点击内容即可局部修改');
    expect(html).toContain('aria-label="选择成果块 1"');
    expect(html).toContain('aria-label="收起成果画布"');
  });

  it('marks the canvas as live while the assistant is generating', () => {
    const html = renderToStaticMarkup(<ArtifactCanvas artifactId="m1" text="正在生成" streaming onApplyText={vi.fn()} onRequestRevision={vi.fn()} />);
    expect(html).toContain('正在生成');
    expect(html).toContain('artifact-live-dot');
  });
});
