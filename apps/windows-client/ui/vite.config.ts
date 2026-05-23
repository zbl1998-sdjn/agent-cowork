import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the React UI into ../ui-dist so the Tauri shell can point its
// `frontendDist` there once the migration is verified. Dev server runs on
// 5173; the UI talks to the Node host at http://127.0.0.1:3017 via the API
// client (absolute URL), so the host and UI dev servers coexist.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: '../ui-dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
