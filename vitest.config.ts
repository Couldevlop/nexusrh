import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/seed.ts',
        '**/migrations/**',
      ],
    },
    include: ['apps/api/src/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@nexusrh/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
})
