import { test, expect } from '@playwright/test'

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
  })

  test('should display the login page', async ({ page }) => {
    await expect(page).toHaveTitle(/NexusRH/)
    await expect(page.getByPlaceholder(/email/i)).toBeVisible()
    await expect(page.getByPlaceholder(/mot de passe|password/i)).toBeVisible()
  })

  test('should show error on invalid credentials', async ({ page }) => {
    await page.getByPlaceholder(/email/i).fill('wrong@test.com')
    await page.getByPlaceholder(/mot de passe|password/i).fill('wrongpassword')
    await page.getByRole('button', { name: /connexion|se connecter/i }).click()

    await expect(page.getByText(/email ou mot de passe incorrect|invalid/i)).toBeVisible({
      timeout: 5000,
    })
  })

  test('should login successfully as admin', async ({ page }) => {
    await page.getByPlaceholder(/email/i).fill('admin@nexusrh.com')
    await page.getByPlaceholder(/mot de passe|password/i).fill('Admin1234!')
    await page.getByRole('button', { name: /connexion|se connecter/i }).click()

    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 })
  })

  test('should redirect unauthenticated users to login', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
  })

  test('should logout successfully', async ({ page }) => {
    // Login first
    await page.getByPlaceholder(/email/i).fill('admin@nexusrh.com')
    await page.getByPlaceholder(/mot de passe|password/i).fill('Admin1234!')
    await page.getByRole('button', { name: /connexion|se connecter/i }).click()
    await page.waitForURL(/\/dashboard/)

    // Logout
    await page.getByRole('button', { name: /déconnexion|logout/i }).click()
    await expect(page).toHaveURL(/\/login/)
  })

  test('should prefill credentials with demo buttons', async ({ page }) => {
    const demoButton = page.getByRole('button', { name: /admin/i }).first()
    if (await demoButton.isVisible()) {
      await demoButton.click()
      const emailInput = page.getByPlaceholder(/email/i)
      await expect(emailInput).toHaveValue('admin@nexusrh.com')
    }
  })
})
