import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import UnoCSS from 'unocss/vite';

/**
 * 孪生独立站：固定 5174 端口（strictPort，避免静默漂到别的端口造成混淆）。
 * /api 预留网关代理（默认 8080），接真实数据时 HUD/3D 无需改动，只换数据源。
 */
export default defineConfig({
  plugins: [UnoCSS(), react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.GATEWAY_BASE || 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
