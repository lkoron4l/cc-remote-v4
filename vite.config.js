import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// PWA無効化中（開発フェーズ）— Step 15で再有効化
// import { VitePWA } from 'vite-plugin-pwa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Serve dev-only assets (dev/*.html) via middleware; never included in production build.
const devOnlyAssets = () => ({
  name: 'dev-only-assets',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/dev_seed.html', (req, res, next) => {
      const filePath = path.resolve(__dirname, 'dev/dev_seed.html');
      if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        fs.createReadStream(filePath).pipe(res);
      } else {
        next();
      }
    });
  },
});

export default defineConfig({
  base: process.env.PAGES_BUILD === '1' ? '/cc-remote-v4/' : '/',
  plugins: [
    react(),
    devOnlyAssets(),
    // VitePWA — Step 15で再有効化時にキャッシュ戦略も見直す
  ],
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3737',
        changeOrigin: true,
      },
      '/sse': {
        target: 'http://localhost:3737',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
