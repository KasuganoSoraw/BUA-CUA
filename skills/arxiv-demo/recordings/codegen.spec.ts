import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://arxiv.org/');
  await page.getByRole('textbox', { name: 'Search term or terms' }).click();
  await page.getByRole('textbox', { name: 'Search term or terms' }).click();
  await page.getByRole('textbox', { name: 'Search term or terms' }).press('CapsLock');
  await page.getByRole('textbox', { name: 'Search term or terms' }).fill('LLM AGENT');
  await page.getByRole('textbox', { name: 'Search term or terms' }).press('CapsLock');
  await page.locator('#header').getByRole('button', { name: 'Search' }).click();
  await page.getByLabel('Sort results by').selectOption('');
  await page.getByRole('button', { name: 'Go' }).click();
  await page.getByRole('link', { name: 'pdf' }).first().click();
  await page.locator('iframe[name="8A31C5867E0A8ABA66EE3D5581AF4B04"]').contentFrame().getByRole('button', { name: '下载' }).click();
});
