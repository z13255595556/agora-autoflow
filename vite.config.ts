import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    // 物理机可用 VITE_PUBLIC_BASE=/autoflow/ 构建；本地和独立域名仍是根路径。
    base: env.VITE_PUBLIC_BASE || '/',
    plugins: [react()],
    server: { port: 5273 },
  }
})
