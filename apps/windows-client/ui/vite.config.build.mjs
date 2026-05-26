import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export function manualChunks(id) {
  const normalized = id.replace(/\\/g, '/');
  if (normalized.indexOf('/node_modules/react') >= 0 || normalized.indexOf('/node_modules/react-dom') >= 0) return 'vendor-react';
  if (normalized.indexOf('/node_modules/recharts') >= 0) return 'vendor-charts';
  if (normalized.indexOf('/node_modules/marked') >= 0 || normalized.indexOf('/node_modules/markdown') >= 0) return 'vendor-markdown';
  if (normalized.indexOf('/src/lib/md') >= 0) return 'markdown';
  if (normalized.indexOf('/src/components/ToolsPanel') >= 0 || normalized.indexOf('/src/components/panels/ToolsPanel') >= 0) return 'panel-tools';
  if (normalized.indexOf('/src/components/VizPanel') >= 0 || normalized.indexOf('/src/components/panels/VizPanel') >= 0) return 'panel-viz';
  if (normalized.indexOf('/src/components/ConnectorsPanel') >= 0 || normalized.indexOf('/src/components/panels/ConnectorsPanel') >= 0) return 'panel-connectors';
  if (normalized.indexOf('/src/components/ArtifactsPanel') >= 0 || normalized.indexOf('/src/components/panels/ArtifactsPanel') >= 0) return 'panel-artifacts';
  if (normalized.indexOf('/src/components/SchedulesPanel') >= 0 || normalized.indexOf('/src/components/panels/SchedulesPanel') >= 0) return 'panel-schedules';
  if (normalized.indexOf('/src/components/MemoryPanel') >= 0 || normalized.indexOf('/src/components/panels/MemoryPanel') >= 0) return 'panel-memory';
  if (normalized.indexOf('/src/components/ObservabilityPanel') >= 0 || normalized.indexOf('/src/components/panels/ObservabilityPanel') >= 0) return 'panel-observability';
  return undefined;
}

// One-off production config for sandboxed builds: the Windows folder mount
// forbids deletes, so emptyOutDir must stay false and asset names are fixed
// (no content hash) so each build overwrites the same files in place.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../ui-dist',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/chunk-[name].js',
        assetFileNames: 'assets/app.[ext]',
        manualChunks,
      },
    },
  },
});
