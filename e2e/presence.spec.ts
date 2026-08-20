/**
 * Knowing whether the other player is sitting there.
 *
 * The relay has always known which participants hold a live socket — it uses
 * that to decide whether a push is worth sending. Presence is that same fact,
 * said out loud. Nothing about a game depends on it; it exists so a person
 * deciding whether to wait for a reply can tell.
 */
import { expect, test } from '@playwright/test';

import { inviteLink, startGame } from './helpers.ts';

const HERE = 'Your opponent is here.';

test('each player is told when the other is on the board, and when they go', async ({
  browser,
}) => {
  const one = await browser.newContext();
  const a = await one.newPage();

  await a.goto('/');
  await startGame(a, 'tictactoe');
  await expect(a.getByRole('heading', { name: 'Waiting for a player' })).toBeVisible();
  const link = await inviteLink(a);

  const two = await browser.newContext();
  const b = await two.newPage();
  await b.goto(link);

  // Both boards are up, so both sockets are open and each should say so.
  await expect(a.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 30_000 });
  await expect(a.getByText(HERE)).toBeVisible({ timeout: 30_000 });
  await expect(b.getByText(HERE)).toBeVisible({ timeout: 30_000 });

  // Closing the second player's page closes their socket. The first player
  // finds out without having to try a move first.
  await b.close();
  await expect(a.getByText(HERE)).toBeHidden({ timeout: 30_000 });

  await one.close();
  await two.close();
});

test('a player alone in a game is not told anyone is there', async ({ browser }) => {
  const one = await browser.newContext();
  const a = await one.newPage();

  await a.goto('/');
  await startGame(a, 'tictactoe');
  await expect(a.getByRole('heading', { name: 'Waiting for a player' })).toBeVisible();
  const link = await inviteLink(a);

  const two = await browser.newContext();
  const b = await two.newPage();
  await b.goto(link);
  await expect(a.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 30_000 });
  await b.close();

  // Reloading with nobody else connected must not resurrect the indicator from
  // a stale board state.
  await a.reload();
  await expect(a.locator('.board button').first()).toBeVisible({ timeout: 30_000 });
  await expect(a.getByText(HERE)).toBeHidden();

  await one.close();
  await two.close();
});
