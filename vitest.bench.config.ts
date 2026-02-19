/**
 * Vitest benchmark configuration.
 *
 * Separate from the main vitest.config.ts to avoid running benchmarks
 * across all test projects. Benchmarks run once via `pnpm test:bench`.
 */

import { defineConfig } from 'vitest/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@carapace/core/': resolve(__dirname, './src/core/'),
      '@carapace/core': resolve(__dirname, './src/core'),
      '@carapace/ipc/': resolve(__dirname, './src/ipc/'),
      '@carapace/ipc': resolve(__dirname, './src/ipc'),
      '@carapace/plugins/': resolve(__dirname, './src/plugins/'),
      '@carapace/plugins': resolve(__dirname, './src/plugins'),
      '@carapace/types/': resolve(__dirname, './src/types/'),
      '@carapace/types': resolve(__dirname, './src/types'),
      '@carapace/container/': resolve(__dirname, './src/container/'),
      '@carapace/container': resolve(__dirname, './src/container'),
      '@carapace/testing/': resolve(__dirname, './src/testing/'),
      '@carapace/testing': resolve(__dirname, './src/testing'),
    },
  },
  test: {
    benchmark: {
      include: ['src/benchmarks/**/*.bench.ts'],
    },
  },
});
