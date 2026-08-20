/**
 * Backup and device migration, end to end.
 *
 * A game is played, exported, and restored into a completely fresh browser
 * profile — a different IndexedDB, a different identity until the import runs.
 * The restored profile then has to be able to keep playing, which is the only
 * check that actually proves the backup carried everything it needed to.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { startGame } from './helpers.ts';

const PASSPHRASE = 'correct horse battery staple';

async function newPlayer(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.goto('/');
  return page;
}

async function inviteLink(page: Page): Promise<string> {
  await expect(page.getByTestId('status')).toContainText('Waiting for someone');
  return page.evaluate(
    () => document.querySelector<HTMLElement>('[data-invite-link]')?.dataset.inviteLink ?? '',
  );
}

/** Sets up a game in progress between two profiles. */
async function playedGame(browser: BrowserContext['browser']) {
  const alice = await browser!.newContext();
  const bob = await browser!.newContext();

  const a = await newPlayer(alice);
  await startGame(a);
  const link = await inviteLink(a);

  const b = await newPlayer(bob);
  await b.goto(link);
  await expect(a.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 20_000 });

  // Alice opens in the centre; Bob answers in a corner.
  await a.locator('.board button').nth(4).click();
  await expect(b.locator('.board button').nth(4)).not.toBeEmpty();
  await b.locator('.board button').nth(0).click();
  await expect(a.locator('.board button').nth(0)).not.toBeEmpty();

  return { alice, bob, a, b };
}

test('a backup restores into a fresh profile and the game continues', async ({ browser }) => {
  const { alice, bob, a, b } = await playedGame(browser);

  // Alice's public key before the migration, to prove the identity moved.
  await a.goto('/settings');
  await expect(a.locator('.key')).not.toBeEmpty();
  const originalKey = (await a.locator('.key').textContent())!.trim();

  // Export.
  await a.getByLabel('Passphrase').first().fill(PASSPHRASE);
  const download = a.waitForEvent('download');
  await a.getByRole('button', { name: 'Download backup' }).click();
  const file = await (await download).path();
  expect(file).toBeTruthy();

  // A brand new device: nothing in storage, a different identity.
  const replacement = await browser.newContext();
  const c = await newPlayer(replacement);
  await c.goto('/settings');
  await expect(c.locator('.key')).not.toBeEmpty();
  const strangerKey = (await c.locator('.key').textContent())!.trim();
  expect(strangerKey).not.toBe(originalKey);

  // Restore.
  await c.locator('input[type="file"]').setInputFiles(file!);
  await c.getByLabel('Passphrase').nth(1).fill(PASSPHRASE);
  await c.getByRole('button', { name: 'Restore' }).click();
  await c.getByRole('button', { name: 'Yes, replace this device' }).click();
  await expect(c.getByText(/Restored 1 game/)).toBeVisible();

  // The identity came with it.
  await c.reload();
  await expect(c.locator('.key')).toHaveText(originalKey);

  // And the game is playable from the new device: the restored log verified,
  // decrypted, and replayed, which it could not do without the identity key.
  await c.goto('/');
  await c.getByRole('link', { name: /Tic tac toe/ }).click();
  await expect(c.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible();
  await expect(c.locator('.board button').nth(4)).not.toBeEmpty();
  await expect(c.locator('.board button').nth(0)).not.toBeEmpty();

  await expect(c.getByText('Your turn.')).toBeVisible({ timeout: 20_000 });
  await c.locator('.board button').nth(8).click();

  // The opponent, still on their original device, receives the move.
  await expect(b.locator('.board button').nth(8)).not.toBeEmpty({ timeout: 20_000 });

  await alice.close();
  await bob.close();
  await replacement.close();
});

test('a backup will not open with the wrong passphrase', async ({ browser }) => {
  const { alice, bob, a } = await playedGame(browser);

  await a.goto('/settings');
  await a.getByLabel('Passphrase').first().fill(PASSPHRASE);
  const download = a.waitForEvent('download');
  await a.getByRole('button', { name: 'Download backup' }).click();
  const file = await (await download).path();

  const other = await browser.newContext();
  const c = await newPlayer(other);
  await c.goto('/settings');
  await c.locator('input[type="file"]').setInputFiles(file!);
  await c.getByLabel('Passphrase').nth(1).fill('not the passphrase');
  await c.getByRole('button', { name: 'Restore' }).click();
  await c.getByRole('button', { name: 'Yes, replace this device' }).click();

  await expect(c.getByText(/Wrong passphrase/)).toBeVisible();

  await alice.close();
  await bob.close();
  await other.close();
});
