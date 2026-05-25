import { describe, expect, it } from 'vitest';
import { formatDependencyBytes, toRuntimeDependencyViewModel } from './runtime-dependencies';
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
      { id: 'node', section: 'A4', label: 'Node runtime', required: true, installMode: 'bundled', estimatedDownloadBytes: 0, status: 'available' },
      { id: 'python-embedded', section: 'A2', label: 'Embedded Python', required: true, installMode: 'bundled', estimatedDownloadBytes: 0, status: 'missing' },
      { id: 'sandbox-isolation', section: 'C1', label: 'Sandbox isolation', required: false, installMode: 'system', estimatedDownloadBytes: 0, status: 'degraded' },
    ]));

    expect(vm.summary.readyCount).toBe(1);
    expect(vm.requiredIssues.map((item) => item.id)).toEqual(['python-embedded']);
    expect(vm.requiredIssues[0].severity).toBe('error');
    expect(vm.summary.optionalMissing).toBe(1);
  });

  it('formats on-demand download sizes and zero-byte install modes', () => {
    expect(formatDependencyBytes(200 * 1024 * 1024, 'on-demand')).toBe('约 200MB');
    expect(formatDependencyBytes(0, 'bundled')).toBe('随包');
    expect(formatDependencyBytes(0, 'system')).toBe('系统探测');
  });

  it('keeps section grouping in catalog order', () => {
    const vm = toRuntimeDependencyViewModel(response([
      { id: 'node', section: 'A4', label: 'Node runtime', required: true, installMode: 'bundled', estimatedDownloadBytes: 0, status: 'available' },
      { id: 'pandoc', section: 'B4', label: 'Pandoc', required: false, installMode: 'on-demand', estimatedDownloadBytes: 80 * 1024 * 1024, status: 'missing' },
      { id: 'mingit', section: 'B6', label: 'MinGit', required: false, installMode: 'on-demand', estimatedDownloadBytes: 80 * 1024 * 1024, status: 'unknown' },
    ]));

    expect(vm.sections.map((section) => section.id)).toEqual(['A4', 'B4', 'B6']);
    expect(vm.sections[1].items[0]).toMatchObject({
      id: 'pandoc',
      statusLabel: '缺失',
      installModeLabel: '按需下载',
      downloadLabel: '约 80MB',
    });
    expect(vm.summary.onDemandCount).toBe(2);
  });
});
