import { test, expect } from '@playwright/test';

test('authenticated session (from global-setup) loads the app shell, not a login screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Bibliothek' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Patienten' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Logout/i })).toBeVisible();
});
