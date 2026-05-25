import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RuntimeDependencyInstallPlanPreview } from './RuntimeDependenciesPanel';

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
});
