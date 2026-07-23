import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'window',
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
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