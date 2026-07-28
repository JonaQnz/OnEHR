import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { core: path.resolve(__dirname, '../../packages/core/src') },
  },
  define: {
    global: 'window',
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.API_URL || 'http://api:3001',
        changeOrigin: true,
      },
    },
    watch: {
      usePolling: true,
    },
  },
  optimizeDeps: {
    include: ['react-form-builder2'],
  },
  build: {
    commonjsOptions: {
      include: [/react-form-builder2/, /node_modules/],
    },
  },
})