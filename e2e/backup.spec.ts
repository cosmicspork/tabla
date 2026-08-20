/**
 * Backup and device migration, end to end.
 *
 * A game is played, exported, and restored into a completely fresh browser
 * profile — a different IndexedDB, a different identity until the import runs.
 * The restored profile then has to be able to keep playing, which is the only
 * check that actually proves the backup carried everything it needed to.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { introduce, startGame } from './helpers.ts';

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

/**
 * This device's whole public key.
 *
 * Behind a disclosure on the profile page: confirming a fingerprint out loud is
 * what a person needs, and the full key is for when they want to be certain.
 */
async function readKey(page: Page): Promise<string> {
  await page.goto('/settings/profile');
  await page.getByRole('button', { name: 'Show the whole key' }).click();
  const key = page.getByTestId('full-key');
  await expect(key).not.toBeEmpty();
  return (await key.textContent())!.trim();
}

test('a backup restores into a fresh profile and the game continues', async ({ browser }) => {
  const { alice, bob, a, b } = await playedGame(browser);

  // Alice's public key before the migration, to prove the identity moved.
  const originalKey = await readKey(a);

  // Export.
  await a.goto('/settings/backup');
  await a.getByLabel('Passphrase').first().fill(PASSPHRASE);
  const download = a.waitForEvent('download');
  await a.getByRole('button', { name: 'Download backup' }).click();
  const file = await (await download).path();
  expect(file).toBeTruthy();

  // A brand new device: nothing in storage, a different identity.
  const replacement = await browser.newContext();
  const c = await newPlayer(replacement);
  const strangerKey = await readKey(c);
  expect(strangerKey).not.toBe(originalKey);

  // Restore.
  await c.goto('/settings/backup');
  await c.locator('input[type="file"]').setInputFiles(file!);
  await c.getByLabel('Passphrase').nth(1).fill(PASSPHRASE);
  await c.getByRole('button', { name: 'Restore' }).click();
  await c.getByRole('button', { name: 'Yes, replace this device' }).click();
  await expect(c.getByText(/Restored 1 game/)).toBeVisible();

  // The identity came with it.
  expect(await readKey(c)).toBe(originalKey);

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

  await a.goto('/settings/backup');
  await a.getByLabel('Passphrase').first().fill(PASSPHRASE);
  const download = a.waitForEvent('download');
  await a.getByRole('button', { name: 'Download backup' }).click();
  const file = await (await download).path();

  const other = await browser.newContext();
  const c = await newPlayer(other);
  await c.goto('/settings/backup');
  await c.locator('input[type="file"]').setInputFiles(file!);
  await c.getByLabel('Passphrase').nth(1).fill('not the passphrase');
  await c.getByRole('button', { name: 'Restore' }).click();
  await c.getByRole('button', { name: 'Yes, replace this device' }).click();

  await expect(c.getByText(/Wrong passphrase/)).toBeVisible();

  await alice.close();
  await bob.close();
  await other.close();
});

test('a restored device still knows what it is called', async ({ browser }) => {
  const alice = await browser.newContext();
  const a = await alice.newPage();

  await a.goto('/');
  await introduce(a, 'Ada');

  await a.goto('/settings/backup');
  await a.getByLabel('Passphrase').first().fill(PASSPHRASE);
  const download = a.waitForEvent('download');
  await a.getByRole('button', { name: 'Download backup' }).click();
  const file = await (await download).path();

  const replacement = await browser.newContext();
  const c = await replacement.newPage();
  await c.goto('/');
  // A device with no identity of its own: the welcome screen offers exactly
  // this route, and it must not ask a restored device who it is.
  await c.getByRole('link', { name: /I have a backup/ }).click();
  await c.locator('input[type="file"]').setInputFiles(file!);
  await c.getByLabel('Passphrase').nth(1).fill(PASSPHRASE);
  await c.getByRole('button', { name: 'Restore' }).click();
  await c.getByRole('button', { name: 'Yes, replace this device' }).click();
  await expect(c.getByText(/Restored/)).toBeVisible();

  // The name came with the identity it belongs to. Without this the device
  // would introduce itself to everyone it met next as nobody, and the person
  // holding it would never find out — the people they had already played kept
  // the name on their own side.
  await c.goto('/settings/profile');
  await expect(c.getByTestId('display-name')).toHaveValue('Ada');

  // And it is the name that actually travels, not just one that is displayed.
  const bob = await browser.newContext();
  const b = await bob.newPage();
  await b.goto('/');
  await introduce(b, 'Pooja');

  await c.goto('/');
  await c.getByRole('link', { name: 'Start a new game' }).click();
  await c.locator('button[data-game="tictactoe"]').click();
  await c.getByRole('button', { name: /Make an invite link/ }).click();
  await expect(c.getByTestId('status')).toContainText('Waiting for someone');
  await b.goto(await inviteLink(c));

  await expect(b.locator('.board button')).toHaveCount(9, { timeout: 20_000 });
  await b.goto('/');
  await expect(b.getByText('Tic tac toe with Ada')).toBeVisible();

  await alice.close();
  await replacement.close();
  await bob.close();
});
