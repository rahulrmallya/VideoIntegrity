import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Backend (FastAPI) runs on 127.0.0.1:8000 — CONTRACT §1.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // One offline app served from localhost: a single ~500 kB bundle is fine, no need to code-split.
  build: { chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
