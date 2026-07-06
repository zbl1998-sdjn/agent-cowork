import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import { VizPanel, VizPanelActions, VizPanelErrorState } from './VizPanel';
import { ProjectVizOverview, projectVizSpecFromSnapshot } from './project-viz';
import { WorkbenchLivePreview, buildWorkbenchLivePreviewModel } from './workbench-preview';

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

describe('VizPanel state views', () => {
  it('renders without an error state by default', () => {
    const html = renderToStaticMarkup(<VizPanel trustedRoot="C:/work" />);

    expect(html).toContain('实时工作台');
    expect(html).toContain('工作台预览');
    expect(html).toContain('Agent Cowork 项目视图');
    expect(html).toContain('渲染当前项目活页');
    expect(html).toContain('手动 JSON 活页');
    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('渲染活页');
    expect(html).not.toContain('state-view--error');
  });

  it('renders project-specific metrics and lists', () => {
    const html = renderToStaticMarkup(
      <ProjectVizOverview
        snapshot={{
          trustedRoot: 'C:/work/agent-cowork',
          runs: [{ id: 'run_1', type: 'agent', status: 'done', promptPreview: '生成日报', startedAt: '2026-07-03T01:00:00Z' }],
          artifacts: [{ path: 'C:/work/agent-cowork/artifacts/report.html', name: 'report.html', kind: 'html', modifiedAt: '2026-07-03T01:01:00Z' }],
          providerCount: 4,
          localProviderCount: 2,
          activeProvider: 'ollama',
          activeModel: 'qwen3:8b',
          chatEnabled: true,
          loadedAt: '2026-07-03T01:02:00Z',
        }}
        busy={false}
        error=""
        onRefresh={() => {}}
        onRenderProject={() => {}}
      />,
    );

    expect(html).toContain('agent-cowork');
    expect(html).toContain('ollama / qwen3:8b');
    expect(html).toContain('生成日报');
    expect(html).toContain('report.html');
  });

  it('renders a live spreadsheet preview from the current workbench draft', () => {
    const preview = {
      text: '把销售 Excel 合并成季度汇总表，并输出 PDF',
      files: [{ name: 'sales-q1.xlsx', size: 2048, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', lastModified: 1 }],
      provider: 'ollama',
      model: 'qwen3:8b',
      thinking: 'standard' as const,
      updatedAt: '2026-07-03T01:02:00Z',
      mode: 'execute' as const,
      workspace: 'C:/work/agent-cowork',
      recipe: { id: 'r1', name: '季度汇总模板' },
      streaming: false,
    };
    const html = renderToStaticMarkup(<WorkbenchLivePreview preview={preview} />);
    const model = buildWorkbenchLivePreviewModel(preview);

    expect(model.kind).toBe('spreadsheet');
    expect(model.formats).toContain('XLSX');
    expect(html).toContain('表格 / 数据');
    expect(html).toContain('sales-q1.xlsx');
    expect(html).toContain('ollama / qwen3:8b');
    expect(html).toContain('季度汇总模板');
  });

  it('builds a table live-artifact spec from the current project snapshot', () => {
    const spec = JSON.parse(projectVizSpecFromSnapshot({
      trustedRoot: 'C:/work',
      runs: [{ id: 'run_1', type: 'agent', status: 'failed' }],
      artifacts: [],
      providerCount: 3,
      localProviderCount: 1,
      activeProvider: 'ollama',
      activeModel: 'qwen3:8b',
      chatEnabled: false,
      loadedAt: '2026-07-03T01:02:00Z',
    })) as { title: string; kind: string; data: { rows: string[][] } };

    expect(spec.title).toBe('Agent Cowork 项目态势');
    expect(spec.kind).toBe('table');
    expect(spec.data.rows).toContainEqual(['失败运行', '1']);
    expect(spec.data.rows).toContainEqual(['当前模型', 'ollama / qwen3:8b']);
  });

  it('renders viz failures with the reusable error state', () => {
    const html = renderToStaticMarkup(<VizPanelErrorState error="JSON 解析失败" />);

    expect(html).toContain('活页渲染失败');
    expect(html).toContain('JSON 解析失败');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });

  it('renders render/reopen actions with Button primitives', () => {
    const html = renderToStaticMarkup(
      <VizPanelActions busy viewUrl="/api/artifacts/live/viz_1" onRender={() => {}} onReopen={() => {}} />,
    );

    expect(html.match(/class="ui-btn /g)?.length).toBe(2);
    expect(html).toContain('disabled=""');
    expect(html).toContain('渲染中');
    expect(html).toContain('重开活页');
  });

  it('keeps render and reopen callbacks wired', () => {
    const onRender = vi.fn();
    const onReopen = vi.fn();
    const buttons = collectByType(
      VizPanelActions({ busy: false, viewUrl: '/api/artifacts/live/viz_1', onRender, onReopen }),
      Button,
    );

    expect(buttons).toHaveLength(2);
    buttons[0]!.props.onClick();
    buttons[1]!.props.onClick();

    expect(onRender).toHaveBeenCalledOnce();
    expect(onReopen).toHaveBeenCalledOnce();
  });
});
