import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://clinicaltrials.gov/');
  await page.getByRole('combobox', { name: 'Condition/disease' }).click();
  await page.getByRole('combobox', { name: 'Condition/disease' }).fill('dia');
  await page.getByRole('option', { name: 'Diabetes', exact: true }).click();
  await page.getByText('Recruiting and not yet').click();
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByText('Male (2,623)').click();
  await page.getByText('Child (birth - 17) (399)').click();
  await page.getByRole('button', { name: 'Apply Filters' }).click();
  await page.locator('.selection > .usa-checkbox__label').first().click();
  await page.locator('ctg-search-hit-card:nth-child(4) > .usa-card__container > .headline > .selection > .usa-checkbox__label').click();
  await page.locator('ctg-search-hit-card:nth-child(5) > .usa-card__container > .headline > .selection > .usa-checkbox__label').click();
  await page.getByLabel('download', { exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
});