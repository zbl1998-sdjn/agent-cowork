import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  RuntimeDependencyCleanupPlanPreview,
  RuntimeDependencyInstallPlanPreview,
} from './RuntimeDependenciesPanel';

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
