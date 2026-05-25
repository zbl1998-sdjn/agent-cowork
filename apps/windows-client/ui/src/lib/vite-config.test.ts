import { describe, expect, it } from 'vitest';
import { manualChunks } from '../../vite.config';

describe('vite manualChunks', () => {
  it('splits React dependencies into a vendor chunk', () => {
    expect(manualChunks('C:/repo/node_modules/react/index.js')).toBe('vendor-react');
    expect(manualChunks('C:/repo/node_modules/react-dom/client.js')).toBe('vendor-react');
  });

  it('splits panel chunks away from the startup bundle', () => {
    expect(manualChunks('C:/repo/src/components/ToolsPanel.tsx')).toBe('panel-tools');
    expect(manualChunks('C:/repo/src/components/panels/SchedulesPanel.tsx')).toBe('panel-schedules');
    expect(manualChunks('C:/repo/src/components/ObservabilityPanel.tsx')).toBe('panel-observability');
  });

  it('keeps unrelated app modules in the default chunking path', () => {
    expect(manualChunks('C:/repo/src/App.tsx')).toBeUndefined();
  });
});
