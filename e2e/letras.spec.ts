/**
 * The word game, played between two real browser profiles.
 *
 * These tests do something the Rust tests cannot: they check that the whole
 * pipe holds when the two halves of a game are genuinely separate. Each profile
 * has its own identity, its own IndexedDB, and — crucially — its own half of
 * the deck key, so the tiles one of them holds are not merely hidden from the
 * other but genuinely unreadable by it.
 *
 * The word list is fetched over the network here for real, from the relay's
 * static assets, and hash-checked before it reaches the sandbox.
 */
import { expect, test } from '@playwright/test';

import { gameWhereMoverCanSpell, letrasGame, onTurn, playWord, rackOf } from './helpers.ts';

test('two players play a word through the relay', async ({ browser }) => {
  const { one, two, mover, other: waiter, indices } = await gameWhereMoverCanSpell(browser, true);

  await playWord(mover, indices);

  // The tiles land on the opponent's board too, which is the whole point.
  await expect(waiter.locator('.square.filled')).toHaveCount(indices.length, {
    timeout: 30_000,
  });
  await expect(waiter.getByText('Your turn.')).toBeVisible({ timeout: 30_000 });

  // The rack is short until the opponent moves, and the UI says why. Drawing
  // any earlier would let a player see their next tiles before deciding how
  // many to spend, which is exactly what the nonce ordering prevents.
  await expect(mover.getByText('You draw when they move')).toBeVisible();

  // Once the opponent does move, the refill lands.
  await waiter.getByRole('button', { name: 'Pass' }).click();
  await expect(mover.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });

  await one.close();
  await two.close();
});

test('a word that is not a word is refused, and the tiles stay put', async ({ browser }) => {
  const { one, two, mover, other, indices } = await gameWhereMoverCanSpell(browser, false);

  await playWord(mover, indices);

  // Refused by the rules, so it was never sealed into the log — the opponent
  // has nothing to see and nothing to dispute.
  await expect(mover.getByText(/is not in the word list/)).toBeVisible({ timeout: 30_000 });
  await expect(other.locator('.square.filled')).toHaveCount(0);

  // And the tiles are still where they were put, so one letter can be changed
  // rather than the whole word laid out again.
  await expect(mover.locator('.square.filled')).toHaveCount(indices.length);
  await expect(mover.getByText('Your turn.')).toBeVisible();

  await one.close();
  await two.close();
});

test('the refusal names the word that was the problem', async ({ browser }) => {
  const { one, two, mover, indices, word } = await gameWhereMoverCanSpell(browser, false);

  await playWord(mover, indices);

  // A play can make several words; saying which one leaves a player something
  // to act on.
  await expect(mover.getByText(new RegExp(`${word.toUpperCase()} is not in the word list`))).toBeVisible({
    timeout: 30_000,
  });

  await one.close();
  await two.close();
});

test('a real word is taken without anyone having to vouch for it', async ({ browser }) => {
  const { one, two, mover, other, indices } = await gameWhereMoverCanSpell(browser, true);

  await playWord(mover, indices);

  // Both devices checked the same list against the same play and agreed, which
  // is what the challenge used to be for.
  await expect(other.locator('.square.filled')).toHaveCount(indices.length, { timeout: 30_000 });
  await expect(other.getByText('Your turn.')).toBeVisible({ timeout: 30_000 });
  await expect(other.getByRole('button', { name: 'Challenge' })).toBeHidden();

  await one.close();
  await two.close();
});

test('a half-played game restores onto a fresh device with its rack intact', async ({
  browser,
}) => {
  // The claim the draw design rests on: a rack is not stored anywhere, it is
  // recomputed from the log and the identity key. So a backup that carries the
  // identity key carries the rack, without ever having written it down.
  const { one, two, mover, other, indices } = await gameWhereMoverCanSpell(browser, true);

  await playWord(mover, indices);

  // Let the opponent move so the refill lands before we take a backup.
  await expect(other.getByText('Your turn.')).toBeVisible({ timeout: 30_000 });
  await other.getByRole('button', { name: 'Pass' }).click();
  await expect(mover.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });
  const refilled = await rackOf(mover);
  const boardNow = await mover.locator('.square.filled').count();

  // Export from the device that has been playing.
  await mover.goto('/settings/backup');
  await mover.getByLabel('Passphrase').first().fill('correct horse battery staple');
  const download = mover.waitForEvent('download');
  await mover.getByRole('button', { name: 'Download backup' }).click();
  const file = await (await download).path();

  // A brand new profile: different identity, empty database.
  const replacement = await browser!.newContext();
  const c = await replacement.newPage();
  await c.goto('/settings/backup');
  await c.locator('input[type="file"]').setInputFiles(file!);
  await c.getByLabel('Passphrase').nth(1).fill('correct horse battery staple');
  await c.getByRole('button', { name: 'Restore' }).click();
  await c.getByRole('button', { name: 'Yes, replace this device' }).click();
  await expect(c.getByText(/Restored 1 game/)).toBeVisible();

  await c.goto('/');
  await c.getByRole('link', { name: /Letras/ }).click();
  await expect(c.getByRole('heading', { name: 'Letras' })).toBeVisible({ timeout: 30_000 });

  // The board came back, and so did the tiles — which were never in the backup.
  await expect(c.locator('.square.filled')).toHaveCount(boardNow, { timeout: 30_000 });
  await expect(c.locator('[data-rack]')).toHaveAttribute('data-rack', refilled, {
    timeout: 30_000,
  });

  await one.close();
  await two.close();
  await replacement.close();
});
