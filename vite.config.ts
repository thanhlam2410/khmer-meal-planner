import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load ALL vars from .env (no VITE_ prefix filter). They stay in this Node
  // process and are never exposed to the client bundle.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    // `npm run build:debug` (mode "debug"): readable bundle + source maps + agent console logs.
    build: { minify: mode !== 'debug', sourcemap: mode === 'debug' },
    // Model id is not a secret; expose it so the UI and the agent use the one set in .env.
    define: { 'import.meta.env.AGENT_MODEL': JSON.stringify(env.AGENT_MODEL ?? '') },
    server: {
      // Mirrors public/.herenow/proxy.json so the app calls /api/chat the same
      // way in dev and on here.now; the key is injected server-side in both.
      proxy: {
        '/api/chat': {
          target: 'https://openrouter.ai',
          changeOrigin: true,
          rewrite: () => '/api/v1/chat/completions',
          headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY ?? ''}` },
        },
      },
    },
  }
})
