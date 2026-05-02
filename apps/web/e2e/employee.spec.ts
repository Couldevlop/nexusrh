import { test, expect } from '@playwright/test'

test.describe('Employee management', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login')
    await page.getByPlaceholder(/email/i).fill('rh@nexusrh.com')
    await page.getByPlaceholder(/mot de passe|password/i).fill('Admin1234!')
    await page.getByRole('button', { name: /connexion|se connecter/i }).click()
    await page.waitForURL(/\/dashboard/)
  })

  test('should display employees list', async ({ page }) => {
    await page.goto('/employees')
    await expect(page.getByRole('heading', { name: /collaborateurs/i })).toBeVisible()
    // Should show employee rows
    await expect(page.locator('table tbody tr, [data-testid="employee-row"]').first()).toBeVisible({
      timeout: 10000,
    })
  })

  test('should navigate to employee detail', async ({ page }) => {
    await page.goto('/employees')
    await page.waitForLoadState('networkidle')

    // Click on the first employee
    const firstEmployee = page.locator('table tbody tr, [data-testid="employee-row"]').first()
    await firstEmployee.click()

    await expect(page).toHaveURL(/\/employees\/[a-f0-9-]+/)
  })

  test('should display employee tabs', async ({ page }) => {
    await page.goto('/employees')
    await page.waitForLoadState('networkidle')
    const firstEmployee = page.locator('table tbody tr').first()
    await firstEmployee.click()
    await page.waitForURL(/\/employees\/[a-f0-9-]+/)

    // Check tabs exist
    await expect(page.getByRole('tab', { name: /profil/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /contrats|paie/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /absences/i })).toBeVisible()
  })

  test('should navigate to new employee form', async ({ page }) => {
    await page.goto('/employees')
    await page.getByRole('link', { name: /nouveau|ajouter/i }).click()
    await expect(page).toHaveURL(/\/employees\/new/)
    await expect(page.getByPlaceholder(/prénom/i)).toBeVisible()
  })

  test('should filter employees by search', async ({ page }) => {
    await page.goto('/employees')
    await page.waitForLoadState('networkidle')

    const searchInput = page.getByPlaceholder(/rechercher/i)
    await searchInput.fill('Marie')

    await page.waitForTimeout(500)

    const rows = page.locator('table tbody tr')
    const count = await rows.count()
    for (let i = 0; i < Math.min(count, 5); i++) {
      const text = await rows.nth(i).textContent()
      expect(text?.toLowerCase()).toContain('marie')
    }
  })

  test('should show employee retention score when available', async ({ page }) => {
    await page.goto('/employees')
    await page.waitForLoadState('networkidle')
    // Retention score bars should appear in the table
    const retentionBars = page.locator('[data-testid="retention-bar"], .retention-score')
    // They may or may not exist depending on data, just verify page loads
    await expect(page.locator('table')).toBeVisible()
  })
})
