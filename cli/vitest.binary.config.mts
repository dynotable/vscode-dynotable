import {defineConfig} from 'vitest/config';

// The compiled-binary lane (`pnpm cli:binary`). `pnpm cli:build` builds the binary first.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['cli/test-binary/**/*.test.ts'],
    // One fake app per test, and each test starts a real process.
    fileParallelism: false,
    testTimeout: 30_000
  }
});
