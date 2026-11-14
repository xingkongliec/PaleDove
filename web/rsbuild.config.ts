import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

export default defineConfig({
  plugins: [pluginReact()],
  html: {
    title: 'PaleDove',
    meta: { viewport: 'width=device-width, initial-scale=1' },
    favicon: './public/logo.png',
  },
  source: {
    entry: { index: './src/main.tsx' },
  },
  resolve: {
    alias: { '@': './src' },
  },
  server: {
    // 明确监听 IPv4 回环地址；默认的 localhost 在部分系统上只绑定 ::1，127.0.0.1 无法访问
    host: '127.0.0.1',
    // 部分 Windows 环境的 5173 端口会被系统保留。
    port: 5180,
    // 账单详情等前端路由需要支持刷新和直接打开
    historyApiFallback: true,
    proxy: {
      // ws：网页终端经 WebSocket 连接 API
      '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false, ws: true },
    },
  },
  output: {
    distPath: { root: 'dist' },
  },
  performance: {
    chunkSplit: { strategy: 'split-by-experience' },
  },
});
