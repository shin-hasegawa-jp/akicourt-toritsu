import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [vue(), vueDevTools()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host: env.WEB_HOST || '127.0.0.1',
      port: Number(env.WEB_PORT || 17590),
      strictPort: true,
      proxy: {
        '/api': {
          target: env.API_PROXY_TARGET || 'http://127.0.0.1:17591',
          rewrite: (path) => path.replace(/^\/api(?=\/|$)/, ''),
        },
      },
    },
  }
})
