import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Caminhos relativos: funciona em / (Cloudflare) e em /flight-tracking/ (GitHub Pages).
  base: './',
  build: {
    chunkSizeWarningLimit: 1200, // maplibre-gl sozinho tem ~1 MB
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        probe: resolve(__dirname, 'probe.html'),
      },
    },
  },
});
