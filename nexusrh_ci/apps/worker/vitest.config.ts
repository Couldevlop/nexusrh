import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // La suite complete du monorepo fait tourner api/web/worker/shared en
    // parallele : sous cette charge, l'amorcage asynchrone d'index.test.ts
    // depassait le testTimeout par defaut (5 s) et le test etait tue avant
    // son assertion. Le delai n'est qu'une borne d'echec, pas une attente.
    testTimeout: 30_000,
  },
})
