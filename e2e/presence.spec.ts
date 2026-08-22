/**
 * Knowing whether the other player is sitting there.
 *
 * The relay has always known which participants hold a live socket. Presence is
 * that fact said out loud. Nothing about a game depends on it; it exists so a
 * person deciding whether to wait for a reply can tell. It is deliberately
 * looser than what a notification is decided on — that asks for a heartbeat
 * too, because an open socket can belong to a phone frozen on its lock screen.
 */
import { expect, test } from '@playwright/test';

import { inviteLink, startGame } from './helpers.ts';

const HERE = 'They are here';

test('each player is told when the other is on the board, and when they go', async ({
  browser,
}) => {
  const one = await browser.newContext();
  const a = await one.newPage();

  await a.goto('/');
  await startGame(a, 'tictactoe');
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  const link = await inviteLink(a);

  const two = await browser.newContext();
  const b = await two.newPage();
  await b.goto(link);

  // Both boards are up, so both sockets are open and each should say so.
  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 30_000 });
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
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  const link = await inviteLink(a);

  const two = await browser.newContext();
  const b = await two.newPage();
  await b.goto(link);
  // Wait for the board rather than the header: the header names the game as
  // soon as the invite exists, so it would not prove the claim has landed —
  // and closing the second page too early leaves the opening entry unwritten.
  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 30_000 });
  await b.close();

  // Reloading with nobody else connected must not resurrect the indicator from
  // a stale board state.
  await a.reload();
  await expect(a.locator('.board button').first()).toBeVisible({ timeout: 30_000 });
  await expect(a.getByText(HERE)).toBeHidden();

  await one.close();
  await two.close();
});
