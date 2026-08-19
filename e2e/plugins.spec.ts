/**
 * Downloading a game, removing it, and getting it back.
 *
 * The word game is not part of the app: its rules are fetched on first play and
 * checked against a signed manifest before anything runs them. These tests
 * watch the network to prove that is really what happens — that the module is
 * requested exactly once however much is played, that removing it frees it, and
 * that the game a player already has still works with nothing downloaded.
 */
import { expect, test, type Page } from '@playwright/test';

import { inviteLink, startGame } from './helpers.ts';

const MODULE = '/plugins/letras-v1.wasm';
const DICTIONARY = '/dict/en-v1.dawg';

/** Every plugin file this page has asked the network for. */
function watchDownloads(page: Page): string[] {
  const seen: string[] = [];

  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === MODULE || path === DICTIONARY) seen.push(path);
  });

  return seen;
}

/** Plays far enough into a word game that the rules have certainly run. */
async function openWordGame(page: Page) {
  await page.goto('/');
  await startGame(page, 'letras');
  await expect(page.getByRole('heading', { name: 'Waiting for a player' })).toBeVisible();
  return inviteLink(page);
}

test('a word game downloads its rules once, then never again', async ({ browser }) => {
  const one = await browser.newContext();
  const a = await one.newPage();
  const downloads = watchDownloads(a);

  const link = await openWordGame(a);

  const two = await browser.newContext();
  const b = await two.newPage();
  await b.goto(link);

  await expect(a.getByRole('heading', { name: 'Letras' })).toBeVisible({ timeout: 30_000 });
  await expect(a.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });

  expect(downloads).toEqual([MODULE, DICTIONARY]);

  // Reloading the page rebuilds the board from scratch: the position, the
  // rack, everything. None of it goes back to the network, because the files
  // are on the device now.
  await a.reload();
  await expect(a.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });

  expect(downloads).toEqual([MODULE, DICTIONARY]);

  await one.close();
  await two.close();
});

test('a downloaded game can be removed and comes back on its own', async ({ browser }) => {
  const one = await browser.newContext();
  const a = await one.newPage();
  const downloads = watchDownloads(a);

  const link = await openWordGame(a);
  const two = await browser.newContext();
  const b = await two.newPage();
  await b.goto(link);

  await expect(a.getByRole('heading', { name: 'Letras' })).toBeVisible({ timeout: 30_000 });
  await expect(a.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });

  // Settings knows what is here and how much room it takes.
  await a.goto('/settings');
  const entry = a.locator('li[data-plugin="letras"]');
  await expect(entry).toContainText('on this device');
  await expect(entry.locator('.size')).not.toHaveAttribute('data-size', '0');

  await entry.getByRole('button', { name: 'Remove' }).click();
  await expect(entry).toContainText('not downloaded');
  await expect(entry.locator('.size')).toHaveAttribute('data-size', '0');

  // The game itself is untouched — logs and keys were never part of this — so
  // opening it simply fetches the rules again and carries on.
  downloads.length = 0;
  await a.goto('/');
  await a.getByRole('link', { name: /Letras/ }).click();

  await expect(a.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });
  expect(downloads).toEqual([MODULE, DICTIONARY]);

  await one.close();
  await two.close();
});

test('the bundled game plays with nothing downloaded at all', async ({ browser }) => {
  // The reason one game stays part of the app: a device that has never had a
  // connection, or a person who removed everything, still has something to
  // play.
  const one = await browser.newContext();
  const a = await one.newPage();
  const downloads = watchDownloads(a);

  await a.goto('/');
  await startGame(a, 'tictactoe');
  await expect(a.getByRole('heading', { name: 'Waiting for a player' })).toBeVisible();
  const link = await inviteLink(a);

  const two = await browser.newContext();
  const b = await two.newPage();
  await b.goto(link);

  await expect(a.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 30_000 });
  await a.locator('.board button').first().click();
  await expect(b.locator('.board button').first()).not.toBeEmpty({ timeout: 30_000 });

  expect(downloads).toEqual([]);

  await one.close();
  await two.close();
});
