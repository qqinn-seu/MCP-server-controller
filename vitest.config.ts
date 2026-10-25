import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'node', pool: 'forks', maxWorkers: 1,
  fileParallelism: false, testTimeout: 15000, hookTimeout: 15000,
  include: ['tests/**/*.test.ts'],
  restoreMocks: true,
} });
