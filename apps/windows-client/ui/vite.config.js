import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export function manualChunks(id) {
    var normalized = id.replace(/\\/g, '/');
    if (normalized.indexOf('/node_modules/react') >= 0 || normalized.indexOf('/node_modules/react-dom') >= 0)
        return 'vendor-react';
    if (normalized.indexOf('/node_modules/recharts') >= 0)
        return 'vendor-charts';
    if (normalized.indexOf('/node_modules/marked') >= 0 || normalized.indexOf('/node_modules/markdown') >= 0)
        return 'vendor-markdown';
    if (normalized.indexOf('/src/lib/md') >= 0)
        return 'markdown';
    if (normalized.indexOf('/src/components/ToolsPanel') >= 0 || normalized.indexOf('/src/components/panels/ToolsPanel') >= 0)
        return 'panel-tools';
    if (normalized.indexOf('/src/components/VizPanel') >= 0 || normalized.indexOf('/src/components/panels/VizPanel') >= 0)
        return 'panel-viz';
    if (normalized.indexOf('/src/components/ConnectorsPanel') >= 0)
        return 'panel-connectors';
    if (normalized.indexOf('/src/components/ArtifactsPanel') >= 0 || normalized.indexOf('/src/components/panels/ArtifactsPanel') >= 0)
        return 'panel-artifacts';
    if (normalized.indexOf('/src/components/SchedulesPanel') >= 0 || normalized.indexOf('/src/components/panels/SchedulesPanel') >= 0)
        return 'panel-schedules';
    if (normalized.indexOf('/src/components/MemoryPanel') >= 0 || normalized.indexOf('/src/components/panels/MemoryPanel') >= 0)
        return 'panel-memory';
    if (normalized.indexOf('/src/components/ObservabilityPanel') >= 0 || normalized.indexOf('/src/components/panels/ObservabilityPanel') >= 0)
        return 'panel-observability';
    return undefined;
}
// Builds the React UI into ../ui-dist so the Tauri shell can point its
// `frontendDist` there once the migration is verified. Dev server runs on
// 5173; the UI talks to the Node host at http://127.0.0.1:3017 via the API
// client (absolute URL), so the host and UI dev servers coexist.
export default defineConfig({
    plugins: [react()],
    test: {
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
    server: { port: 5173, strictPort: true },
    build: {
        outDir: '../ui-dist',
        emptyOutDir: true,
        sourcemap: true,
        rollupOptions: {
            output: { manualChunks: manualChunks },
        },
    },
});
