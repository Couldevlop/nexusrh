import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // L'instrumentation coverage ralentit fortement buildApp() des tests golden :
    // les hooks beforeAll/afterAll dépassent les 10 s par défaut.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/services/**', 'src/modules/**/**.ts'],
      // Génère le rapport même si des tests échouent (défaut: false)
      reportOnFailure: true,
    },
  },
})
