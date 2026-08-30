import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// Reuses vite.config's own aliases (core/openehr-engine point at workspace
// package source, not a built dist/) and dev-server settings via
// mergeConfig, rather than re-declaring them here and risking the two
// configs drifting apart.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
    },
  }),
);
