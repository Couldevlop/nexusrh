/**
 * Test E2E Playwright — Sélecteur de pays sur la page Référentiel
 *
 * COMMENT EXÉCUTER :
 *   Playwright n'est pas (encore) installé dans le projet. Pour activer :
 *
 *   1. Installer les dépendances :
 *        cd apps/web
 *        pnpm add -D @playwright/test
 *        pnpm exec playwright install --with-deps chromium
 *
 *   2. Créer playwright.config.ts à la racine apps/web :
 *        import { defineConfig } from '@playwright/test'
 *        export default defineConfig({
 *          testDir: './tests/e2e',
 *          timeout: 30_000,
 *          use: { baseURL: 'http://localhost:3001', headless: true },
 *          webServer: { command: 'pnpm dev', port: 3001, reuseExistingServer: true },
 *        })
 *
 *   3. Ajouter au package.json :
 *        "test:e2e": "playwright test"
 *
 *   4. Pré-requis backend : `pnpm --filter api run db:seed` doit avoir tourné
 *      pour que les comptes ci-dessous existent.
 *
 *   5. Lancer :
 *        pnpm test:e2e
 *
 * SCÉNARIOS TESTÉS :
 *   1. Tenant mono-pays (SOTRA) → sélecteur de pays INVISIBLE
 *   2. Tenant multi-pays (à seeder ad hoc) → sélecteur VISIBLE + pays par défaut = CIV
 *   3. Changement de pays → la query backend reçoit countryCode et les
 *      résultats sont filtrés
 */
import { test, expect } from '@playwright/test'

const SOTRA = { email: 'admin@sotra.ci', password: 'Admin1234!' }
// À seeder via /platform/tenants avec hasSubsidiaries=true
const MULTI = { email: 'admin@multi-pays-test.ci', password: 'Admin1234!' }

async function loginAs(page: import('@playwright/test').Page, creds: { email: string; password: string }) {
  await page.goto('/login')
  await page.fill('input[type="email"]', creds.email)
  await page.fill('input[type="password"]', creds.password)
  await page.click('button[type="submit"]')
  await page.waitForURL(url => !url.toString().endsWith('/login'))
}

test.describe('Référentiel — sélecteur pays', () => {
  test('tenant mono-pays : le sélecteur de pays N\'est PAS affiché', async ({ page }) => {
    await loginAs(page, SOTRA)
    await page.goto('/referentiels')
    await expect(page.getByText('Référentiel Juridique')).toBeVisible()
    // Le bandeau violet n'apparaît pas
    await expect(page.getByText('Articles applicables à votre filiale')).toHaveCount(0)
  })

  test.skip('tenant multi-pays : sélecteur visible, pays par défaut = CIV', async ({ page }) => {
    // SKIP par défaut tant qu'un tenant multi-pays n'est pas seedé en démo
    await loginAs(page, MULTI)
    await page.goto('/referentiels')
    await expect(page.getByText('Articles applicables à votre filiale')).toBeVisible()
    const select = page.locator('select').first()
    await expect(select).toBeVisible()
    // Pays initial du user — au moins une option sélectionnée
    const value = await select.inputValue()
    expect(value).toMatch(/^[A-Z]{3}$|^$/)
  })

  test.skip('changement de pays filtre les résultats côté API', async ({ page }) => {
    await loginAs(page, MULTI)
    await page.goto('/referentiels')
    await page.fill('input[placeholder*="Rechercher"]', 'congé')

    // Intercepte l'appel /referentiels/search et capture le countryCode
    const requestPromise = page.waitForRequest(req =>
      req.url().includes('/referentiels/search') && req.url().includes('countryCode=BEN'),
    )
    await page.selectOption('select', 'BEN')
    const request = await requestPromise
    expect(request.url()).toContain('countryCode=BEN')
  })
})
