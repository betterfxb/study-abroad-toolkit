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
    // antd 是单体库（含 rc-* 全家桶），拆包后仍 ~598KB，属长效缓存的独立 chunk；
    // 应用 chunk 仅 ~73KB。阈值提到 640 只对 vendor-antd 放行，其余大块继续告警。
    chunkSizeWarningLimit: 640,
    rollupOptions: {
      output: {
        // antd 全家桶（含 rc-* 内部实现与 dayjs）体积大且极少变更，拆出来吃长效缓存；
        // react 单独一块，剩余共享依赖归 vendor。消除单包 >500KB 告警。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](antd|rc-[^\\/]+|@ant-design|@rc-component|dayjs)[\\/]/.test(id)) return 'vendor-antd';
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },
});
