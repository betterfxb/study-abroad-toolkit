import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import UnoCSS from 'unocss/vite';

/**
 * 开发期把 /api 与 /ext 代理到 api-gateway（默认 8080），
 * 前端代码统一使用相对路径，避免跨域与硬编码地址。
 * 生产由 Nginx 托管静态资源并反向代理到网关。
 */
export default defineConfig({
  plugins: [UnoCSS(), react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.GATEWAY_BASE || 'http://localhost:8080', changeOrigin: true },
      '/ext': { target: process.env.GATEWAY_BASE || 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
