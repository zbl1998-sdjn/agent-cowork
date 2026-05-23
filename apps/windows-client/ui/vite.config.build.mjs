import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
      },
    },
  },
});
