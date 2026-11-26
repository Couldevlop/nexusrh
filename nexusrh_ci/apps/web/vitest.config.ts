import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Tests de composants React (jsdom + Testing Library) — `pnpm --filter web test`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Releve le delai d'attente de Testing Library : voir src/test-setup.ts.
    setupFiles: ['./src/test-setup.ts'],
    // Doit rester AU-DESSUS du asyncUtilTimeout de test-setup.ts.
    testTimeout: 20_000,
  },
})
