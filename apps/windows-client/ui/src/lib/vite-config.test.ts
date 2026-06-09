import { describe, expect, it } from 'vitest';
import { manualChunks } from '../../vite.config';

describe('vite manualChunks', () => {
  it('splits React dependencies into a vendor chunk', () => {
    // React/ReactDOM 单独成 vendor chunk,避免业务面板改动导致基础运行时缓存失效。
    expect(manualChunks('C:/repo/node_modules/react/index.js')).toBe('vendor-react');
    expect(manualChunks('C:/repo/node_modules/react-dom/client.js')).toBe('vendor-react');
  });

  it('splits panel chunks away from the startup bundle', () => {
    // 重型面板按域拆 chunk,让首屏包保持轻量并可按需加载。
    expect(manualChunks('C:/repo/src/components/panels/ToolsPanel.tsx')).toBe('panel-tools');
    expect(manualChunks('C:/repo/src/components/panels/VizPanel.tsx')).toBe('panel-viz');
    expect(manualChunks('C:/repo/src/components/panels/ConnectorsPanel.tsx')).toBe('panel-connectors');
    expect(manualChunks('C:/repo/src/components/panels/ArtifactsPanel.tsx')).toBe('panel-artifacts');
    expect(manualChunks('C:/repo/src/components/panels/SchedulesPanel.tsx')).toBe('panel-schedules');
    expect(manualChunks('C:/repo/src/components/panels/MemoryPanel.tsx')).toBe('panel-memory');
    expect(manualChunks('C:/repo/src/components/panels/RuntimeDependenciesPanel.tsx')).toBe('panel-runtime-dependencies');
    expect(manualChunks('C:/repo/src/components/panels/ObservabilityPanel.tsx')).toBe('panel-observability');
  });

  it('keeps unrelated app modules in the default chunking path', () => {
    // 非 vendor/面板路径交回 Vite 默认策略,避免手写分包规则过度匹配。
    expect(manualChunks('C:/repo/src/App.tsx')).toBeUndefined();
  });
});
