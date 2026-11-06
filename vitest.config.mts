import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'media/**/*.test.ts'],
    exclude: ['src/test-integration/**', 'node_modules/**']
  }
});
