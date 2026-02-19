import { defineConfig } from 'vitest/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@carapace/core': resolve(__dirname, './src/core'),
      '@carapace/ipc': resolve(__dirname, './src/ipc'),
      '@carapace/plugins': resolve(__dirname, './src/plugins'),
      '@carapace/types': resolve(__dirname, './src/types'),
      '@carapace/container': resolve(__dirname, './src/container'),
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.{test,spec}.ts', 'src/**/*.d.ts'],
    },
  },
});
