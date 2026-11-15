import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' 让同一份构建产物既能放 Vercel 根路径，也能放 GitHub Pages 的子路径。
export default defineConfig({
  base: './',
  plugins: [react()],
  // Windows 上文件监听偶尔漏掉保存事件，页面会一直用旧代码；改用轮询更可靠（只影响 npm run dev）
  server: { watch: { usePolling: true, interval: 200 } },
});
