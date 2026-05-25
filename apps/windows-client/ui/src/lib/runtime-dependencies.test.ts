import { describe, expect, it } from 'vitest';
import {
  formatDependencyBytes,
  toRuntimeDependencyCleanupPlanViewModel,
  toRuntimeDependencyInstallPlanViewModel,
  toRuntimeDependencyViewModel,
} from './runtime-dependencies';
import type { RuntimeDependencyResponse } from './api/runtimeDependencies';

function response(dependencies: RuntimeDependencyResponse['dependencies']): RuntimeDependencyResponse {
  return {
    ok: true,
    service: 'agent-cowork-host',
    generatedAt: '2026-05-25T00:00:00.000Z',
    platform: 'win32',
    arch: 'x64',
    dependencies,
    summary: { total: dependencies.length, requiredMissing: 0, byStatus: {} },
  };
}

describe('runtime dependency view model', () => {
  it('highlights required missing or degraded dependencies', () => {
    const vm = toRuntimeDependencyViewModel(response([
      { id: 'node', section: 'A4', label: 'Node.js 运行时', description: '启动 host', required: true, installMode: 'bundled', estimatedDownloadBytes: 0, status: 'available', detail: 'host 进程正在使用该运行时' },
      { id: 'python-embedded', section: 'A2', label: '内置 Python', description: '脚本能力', required: true, installMode: 'bundled', estimatedDownloadBytes: 0, status: 'missing' },
      { id: 'sandbox-isolation', section: 'C1', label: '沙箱隔离运行时', description: '隔离工具执行', required: false, installMode: 'system', estimatedDownloadBytes: 0, status: 'degraded' },
    ]));

    expect(vm.summary.readyCount).toBe(1);
    expect(vm.requiredIssues.map((item) => item.id)).toEqual(['python-embedded']);
    expect(vm.requiredIssues[0].severity).toBe('error');
    expect(vm.sections[0].items[0]).toMatchObject({
      label: 'Node.js 运行时',
      purposeLabel: '启动 host',
      detailLabel: 'host 进程正在使用该运行时',
    });
    expect(vm.summary.optionalMissing).toBe(1);
  });

  it('formats on-demand download sizes and zero-byte install modes', () => {
    expect(formatDependencyBytes(200 * 1024 * 1024, 'on-demand')).toBe('约 200MB');
    expect(formatDependencyBytes(0, 'bundled')).toBe('随包');
    expect(formatDependencyBytes(0, 'system')).toBe('系统探测');
  });

  it('keeps section grouping in catalog order', () => {
    const vm = toRuntimeDependencyViewModel(response([
      { id: 'node', section: 'A4', label: 'Node.js 运行时', description: '启动 host', required: true, installMode: 'bundled', estimatedDownloadBytes: 0, status: 'available' },
      { id: 'pandoc', section: 'B4', label: '文档转换组件', description: '转换 Office 和 Markdown', required: false, installMode: 'on-demand', estimatedDownloadBytes: 80 * 1024 * 1024, status: 'missing' },
      { id: 'ffmpeg', section: 'B5', label: '音视频处理组件', description: '处理音视频', required: false, installMode: 'on-demand', estimatedDownloadBytes: 100 * 1024 * 1024, status: 'missing' },
      { id: 'mingit', section: 'B6', label: 'Git 轻量运行时', description: '仓库连接器', required: false, installMode: 'on-demand', estimatedDownloadBytes: 80 * 1024 * 1024, status: 'unknown' },
    ]));

    expect(vm.sections.map((section) => section.id)).toEqual(['A4', 'B4', 'B5', 'B6']);
    expect(vm.sections[1].items[0]).toMatchObject({
      id: 'pandoc',
      label: '文档转换组件',
      purposeLabel: '转换 Office 和 Markdown',
      statusLabel: '缺失',
      installModeLabel: '按需下载',
      downloadLabel: '约 80MB',
    });
    expect(vm.sections[2].items[0]).toMatchObject({
      id: 'ffmpeg',
      label: '音视频处理组件',
      downloadLabel: '约 100MB',
    });
    expect(vm.summary.onDemandCount).toBe(3);
    expect(vm.installPlanCandidateIds).toEqual(['pandoc', 'ffmpeg', 'mingit']);
    expect(vm.installPlanCandidateLabel).toBe('文档转换组件、音视频处理组件、Git 轻量运行时');
  });

  it('summarizes install plan precheck results for the panel', () => {
    const vm = toRuntimeDependencyInstallPlanViewModel({
      ok: false,
      components: [
        {
          id: 'data-science',
          section: 'B1',
          label: '数据分析组件',
          installMode: 'on-demand',
          required: false,
          estimatedDownloadBytes: 200 * 1024 * 1024,
          needsDownload: true,
        },
      ],
      unknownIds: [],
      disk: {
        status: 'insufficient',
        availableBytes: 100 * 1024 * 1024,
        requiredBytes: 200 * 1024 * 1024,
        missingBytes: 100 * 1024 * 1024,
        message: '磁盘空间不足，还需要至少 104857600 字节。',
      },
    });

    expect(vm.title).toBe('安装计划需要处理');
    expect(vm.diskSeverity).toBe('error');
    expect(vm.requiredBytesLabel).toBe('约 200MB');
    expect(vm.missingBytesLabel).toBe('约 100MB');
    expect(vm.componentLabels).toEqual(['数据分析组件']);
  });

  it('summarizes cleanup plan precheck results for the panel', () => {
    const vm = toRuntimeDependencyCleanupPlanViewModel({
      ok: false,
      mode: 'remove-user-data',
      appDataRoot: 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork',
      keepUserData: false,
      unknownIds: ['unknown-component'],
      targets: [
        {
          id: 'runtime-cache',
          label: '运行时下载缓存',
          relativePath: 'cache',
          path: 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork\\cache',
          action: 'remove',
          kind: 'download-cache',
        },
        {
          id: 'user-data',
          label: '本机用户数据',
          relativePath: '.',
          path: 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork',
          action: 'remove',
          kind: 'user-data',
          requiresConfirmation: true,
        },
      ],
      retained: [],
      warnings: ['将删除本机 AgentCowork 用户数据，必须在卸载界面二次确认。'],
    });

    expect(vm.title).toBe('清理计划需要二次确认');
    expect(vm.modeLabel).toBe('删除用户数据');
    expect(vm.requiresConfirmation).toBe(true);
    expect(vm.targetCount).toBe(2);
    expect(vm.targetLabels[0]).toContain('运行时下载缓存');
    expect(vm.warnings[0]).toContain('二次确认');
    expect(vm.unknownIds).toEqual(['unknown-component']);
  });
});
