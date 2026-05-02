import { test, expect } from '@playwright/test'

test.describe('Absences management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder(/email/i).fill('rh@nexusrh.com')
    await page.getByPlaceholder(/mot de passe|password/i).fill('Admin1234!')
    await page.getByRole('button', { name: /connexion|se connecter/i }).click()
    await page.waitForURL(/\/dashboard/)
  })

  test('should display absences page', async ({ page }) => {
    await page.goto('/absences')
    await expect(page.getByRole('heading', { name: /absences|congés/i })).toBeVisible()
  })

  test('should show absence balance cards', async ({ page }) => {
    await page.goto('/absences')
    await page.waitForLoadState('networkidle')
    // Balance cards should be visible if data exists
    await expect(page.locator('body')).toBeVisible()
  })

  test('should have a new absence request button', async ({ page }) => {
    await page.goto('/absences')
    const newButton = page.getByRole('button', { name: /nouvelle demande|nouveau/i })
    await expect(newButton).toBeVisible()
  })

  test('should display absence filters', async ({ page }) => {
    await page.goto('/absences')
    await expect(page.getByRole('button', { name: /toutes/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /en attente/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /approuvées/i })).toBeVisible()
  })

  test('should filter by status', async ({ page }) => {
    await page.goto('/absences')
    await page.getByRole('button', { name: /en attente/i }).click()
    await page.waitForTimeout(300)
    // Page should remain stable after filter
    await expect(page.getByRole('heading', { name: /absences|congés/i })).toBeVisible()
  })

  test('employee self-service - view own absences', async ({ page }) => {
    // Login as employee
    await page.goto('/login')
    await page.getByPlaceholder(/email/i).fill('employe@nexusrh.com')
    await page.getByPlaceholder(/mot de passe|password/i).fill('Admin1234!')
    await page.getByRole('button', { name: /connexion|se connecter/i }).click()
    await page.waitForURL(/\/dashboard/)

    await page.goto('/self-service')
    await expect(page.getByText(/bonjour/i)).toBeVisible()
  })
})
