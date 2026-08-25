import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Aliased straight to source (not the compiled dist/ a plain node_modules
    // resolution would hit) - avoids Rollup's CJS/ESM interop entirely,
    // which otherwise silently drops getter-based named re-exports (like
    // openehr-engine's `export { x } from './metadata'`) for a symlinked
    // workspace package whose real path doesn't match build.commonjsOptions'
    // /node_modules/ include pattern.
    alias: {
      core: path.resolve(__dirname, '../../packages/core/src'),
      'openehr-engine': path.resolve(__dirname, '../../packages/openehr-engine/src'),
    },
  },
  define: {
    // Some legacy browser dependencies reference Node's `global`. `globalThis`
    // is available in both the document and module-worker contexts, whereas
    // `window` crashes every Form Script worker during module evaluation.
    global: 'globalThis',
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
      usePolling: false,
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
