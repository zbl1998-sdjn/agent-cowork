import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import {
  RuntimeDependencyCleanupPlanPreview,
  RuntimeDependencyInstallPlanPreview,
  RuntimeDependenciesPanelView,
} from './RuntimeDependenciesPanel';
import type { RuntimeDependencyViewModel } from '../../lib/runtime-dependencies';

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

function runtimeDependencyViewModel(overrides: Partial<RuntimeDependencyViewModel> = {}): RuntimeDependencyViewModel {
  return {
    summary: {
      total: 2,
      requiredMissing: 1,
      optionalMissing: 1,
      onDemandCount: 2,
      readyCount: 0,
    },
    requiredIssues: [
      {
        id: 'python-runtime',
        label: 'Python 运行时',
        section: 'core',
        status: 'missing',
        required: true,
        installMode: 'on-demand',
        estimatedDownloadBytes: 125,
        description: '执行 Python 工具',
        detail: '未找到 python.exe',
        statusLabel: '缺失',
        severity: 'error',
        installModeLabel: '按需下载',
        downloadLabel: '约 125B',
        purposeLabel: '执行 Python 工具',
        detailLabel: '未找到 python.exe',
        needsAttention: true,
      },
    ],
    sections: [],
    installPlanCandidateIds: ['python-runtime'],
    installPlanCandidateLabel: 'Python 运行时',
    cleanupPlanCandidateIds: ['python-runtime'],
    cleanupPlanCandidateLabel: 'Python 运行时',
    ...overrides,
  };
}

describe('RuntimeDependencyInstallPlanPreview', () => {
  it('renders install plan precheck without execution controls', () => {
    const html = renderToStaticMarkup(
      <RuntimeDependencyInstallPlanPreview
        plan={{
          ok: false,
          title: '安装计划需要处理',
          diskMessage: '未提供可用磁盘空间，安装前仍需预检。',
          diskSeverity: 'warn',
          componentCount: 2,
          requiredBytesLabel: '约 350MB',
          missingBytesLabel: '0 B',
          componentLabels: ['数据分析组件', '浏览器自动化组件'],
          unknownIds: [],
        }}
      />,
    );

    expect(html).toContain('安装计划预检');
    expect(html).toContain('安装计划需要处理');
    expect(html).toContain('2 个组件');
    expect(html).toContain('预计下载 约 350MB');
    expect(html).toContain('数据分析组件');
    expect(html).not.toContain('安装中');
  });

  it('renders cleanup plan precheck with confirmation warning and no delete execution control', () => {
    const html = renderToStaticMarkup(
      <RuntimeDependencyCleanupPlanPreview
        plan={{
          ok: false,
          title: '清理计划需要二次确认',
          modeLabel: '删除用户数据',
          appDataRoot: 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork',
          targetCount: 2,
          targetLabels: [
            '本机用户数据 · C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork',
            '运行时下载缓存 · C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork\\cache',
          ],
          retainedLabels: [],
          warnings: ['将删除本机 AgentCowork 用户数据，必须在卸载界面二次确认。'],
          unknownIds: [],
          requiresConfirmation: true,
        }}
      />,
    );

    expect(html).toContain('清理计划预检');
    expect(html).toContain('清理计划需要二次确认');
    expect(html).toContain('删除用户数据需要卸载界面二次确认');
    expect(html).toContain('本机用户数据');
    expect(html).not.toContain('删除中');
  });
});

describe('RuntimeDependenciesPanelView', () => {
  it('renders panel actions through Button primitives and preserves disabled conditions', () => {
    const html = renderToStaticMarkup(
      <RuntimeDependenciesPanelView
        status="loading"
        error=""
        vm={runtimeDependencyViewModel({
          installPlanCandidateIds: [],
          installPlanCandidateLabel: '暂无需要预检的按需组件',
        })}
        planStatus="idle"
        planError=""
        planVm={null}
        cleanupStatus="loading"
        cleanupError=""
        cleanupVm={null}
        onLoad={() => {}}
        onLoadInstallPlan={() => {}}
        onLoadCleanupPlan={() => {}}
      />,
    );

    expect(html.match(/class="ui-btn /g)?.length).toBe(4);
    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).not.toContain('btn-secondary');
    expect(html).toContain('检测中…');
    expect(html).toContain('暂无需要预检的按需组件');
    expect(html).toContain('生成中…');
    expect(html.match(/disabled=""/g)?.length).toBe(4);
  });

  it('keeps refresh, install-plan, and cleanup-plan callbacks wired through Button primitives', () => {
    const onLoad = vi.fn();
    const onLoadInstallPlan = vi.fn();
    const onLoadCleanupPlan = vi.fn();
    const buttons = collectByType(
      RuntimeDependenciesPanelView({
        status: 'ready',
        error: '',
        vm: runtimeDependencyViewModel(),
        planStatus: 'idle',
        planError: '',
        planVm: null,
        cleanupStatus: 'idle',
        cleanupError: '',
        cleanupVm: null,
        onLoad,
        onLoadInstallPlan,
        onLoadCleanupPlan,
      }),
      Button,
    );

    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.props.disabled)).toEqual([false, false, false, false]);
    buttons[0].props.onClick();
    buttons[1].props.onClick();
    buttons[2].props.onClick();
    buttons[3].props.onClick();

    expect(onLoad).toHaveBeenCalledOnce();
    expect(onLoadInstallPlan).toHaveBeenCalledOnce();
    expect(onLoadCleanupPlan).toHaveBeenCalledTimes(2);
    expect(onLoadCleanupPlan).toHaveBeenNthCalledWith(1, true);
    expect(onLoadCleanupPlan).toHaveBeenNthCalledWith(2, false);
  });
});
