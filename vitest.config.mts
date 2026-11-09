import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'media/**/*.test.ts',
      'cli/**/*.test.ts',
      'claude-plugin/**/*.test.ts'
    ],
    exclude: ['src/test-integration/**', 'cli/test-binary/**', 'node_modules/**']
  }
});
