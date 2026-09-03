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
      // Same CJS/ESM interop problem as 'core' above, but hit specifically
      // via formScript.worker.ts's separate module graph: Vite's dep
      // pre-bundling (which converts CJS -> ESM) only covers the main
      // thread's graph, not a module Worker's. Without this alias the
      // worker requests dist/index.js (plain `exports.foo = ...` CJS)
      // directly and crashes on load with "Uncaught ReferenceError: exports
      // is not defined" - confirmed live 2026-09-03, reproduced even with
      // the pristine origin/main worker file, i.e. pre-existing.
      'formbuilder-plugin-clinical-scores': path.resolve(
        __dirname,
        '../../packages/formbuilder-plugin-clinical-scores/src',
      ),
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
