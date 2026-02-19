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
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.{test,spec}.ts'],
          exclude: [
            'src/**/*.integration.{test,spec}.ts',
            'src/**/*.e2e.{test,spec}.ts',
            'src/**/*.security.{test,spec}.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.{test,spec}.ts'],
        },
      },
      {
        test: {
          name: 'security',
          include: ['src/**/*.security.{test,spec}.ts'],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['src/**/*.e2e.{test,spec}.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.{test,spec}.ts', 'src/**/*.d.ts'],
    },
  },
});
