import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], environment: 'node', testTimeout: 15_000 } },
      {
        test: {
          name: 'int',
          include: ['test/int/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'soak',
          include: ['test/soak/**/*.test.ts'],
          environment: 'node',
          testTimeout: 300_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
