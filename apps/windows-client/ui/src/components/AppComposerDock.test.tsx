import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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

  it('renders a batch template upload control without exposing JSON jargon', () => {
    const html = renderToStaticMarkup(<TemplateUploadBar onUploadTemplates={async () => []} />);

    expect(html).toContain('导入任务模板');
    expect(html).toContain('支持批量任务模板文件');
    expect(html).toContain('class="template-upload-input"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".json,application/json"');
    expect(html).toContain('multiple=""');
    expect(html).not.toContain('支持批量 JSON 模板');
    expect(html).toContain('aria-label="上传任务模板文件"');
  });
});
