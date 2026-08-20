/**
 * The settings hub.
 *
 * Not a tour of every page — each is small — but the two things a hub has to
 * get right: every row goes where it says, and the summaries under them are
 * read from the thing they describe rather than written down beside it.
 */
import { expect, test } from '@playwright/test';

import { startGame } from './helpers.ts';

test('every row opens the page it names, and back returns to the hub', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/settings');

  const rows: [string, string][] = [
    ['Profile', '/settings/profile'],
    ['People', '/settings/people'],
    ['Notifications', '/settings/notifications'],
    ['Appearance', '/settings/appearance'],
    ['Backup & restore', '/settings/backup'],
    ['Storage', '/settings/storage'],
    ['About', '/settings/about'],
  ];

  for (const [name, path] of rows) {
    await page.getByRole('link', { name: new RegExp(name.replace('&', '&')) }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    // The header names the page, and is the only heading on it.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);

    await page.getByTestId('nav-back').click();
    await expect(page).toHaveURL(/\/settings$/);
  }

  await context.close();
});

test('a theme choice outlasts a reload', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/settings/appearance');
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Stored, not just applied: the whole point is that it survives.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true');

  // And system hands the decision back to the device.
  await page.getByTestId('theme-system').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);

  await context.close();
});

test('renaming someone sticks, and the hub says so', async ({ browser }) => {
  const one = await browser.newContext();
  const two = await browser.newContext();

  const a = await one.newPage();
  await a.goto('/');
  await startGame(a);
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  const link = await a.evaluate(
    () => document.querySelector<HTMLElement>('[data-invite-link]')?.dataset.inviteLink ?? '',
  );

  const b = await two.newPage();
  await b.goto(link);
  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 20_000 });

  await a.goto('/settings/people');
  await a.getByRole('button', { name: 'Rename' }).click();
  await a.locator('input').fill('Pooja');
  await a.getByRole('button', { name: 'Save' }).click();
  await expect(a.getByText('Pooja')).toBeVisible();

  // The hub reads its summaries from the data, so it knows without being told.
  await a.goto('/settings');
  await expect(a.getByRole('link', { name: /People/ })).toContainText('Pooja');

  await one.close();
  await two.close();
});
