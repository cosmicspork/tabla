/**
 * On-demand README screenshot capture, not a CI test:
 *
 *     just screenshots
 *
 * Drives the real app against the real relay with real games — the tiles in
 * these pictures were dealt by the actual protocol, not staged — at a phone
 * viewport, and overwrites the committed images in `docs/screenshots/`. Re-run
 * after UI changes so the README never drifts.
 *
 * Nothing here is fixture data in the way svastha's screenshots are: there is
 * no synthetic patient to invent. A game of Letras is its own fixture, and the
 * only thing arranged is *which* word gets played, because a rack that cannot
 * spell anything makes a dull picture.
 */
import { expect, test } from '@playwright/test';

import { gameWhereMoverCanSpell, inviteLink, playWord, startGame } from './helpers.ts';

test.skip(!process.env.SCREENSHOTS, 'screenshot capture runs on demand, not in CI');

// A phone, because that is where a correspondence game actually gets played.
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

const OUT = '../docs/screenshots';

test('invite: the whole of starting a game', async ({ browser }) => {
  // One link to one person. There are no accounts to make and nobody to find.
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/');
  await startGame(page, 'letras');
  await expect(page.getByTestId('status')).toContainText('Waiting for someone');
  await expect(page.locator('[data-invite-link]')).toBeVisible();

  await page.screenshot({ path: `${OUT}/invite.png` });
  await context.close();
});

test('letras: a word on the board, tiles only you can read', async ({ browser }) => {
  // The longest word this rack can make: a two-letter play is a thin picture.
  const { one, two, mover, indices } = await gameWhereMoverCanSpell(browser, true, 'long');

  await playWord(mover, indices);
  await expect(mover.locator('.square.filled').first()).toBeVisible();

  // After the play: the word is down and scored, the rack has refilled from a
  // deck neither player can read, and the bag count is exact.
  await expect(mover.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });

  await mover.screenshot({ path: `${OUT}/letras.png` });
  await one.close();
  await two.close();
});

test('challenge: the opponent decides whether that was a word', async ({ browser }) => {
  // The rule the game is built around — a play is legal the moment it is
  // geometrically sound, and whether it is *English* is the opponent's to
  // raise and to pay for.
  const { one, two, mover, other, indices } = await gameWhereMoverCanSpell(browser, false);

  await playWord(mover, indices);
  await expect(other.getByRole('button', { name: 'Challenge' })).toBeVisible({ timeout: 30_000 });

  await other.screenshot({ path: `${OUT}/challenge.png` });
  await one.close();
  await two.close();
});

test('games on this device: what was downloaded, and how to be rid of it', async ({ browser }) => {
  // The plugin story: rules arrive on first play, checked against a signature,
  // and go away again on request.
  const context = await browser.newContext();
  const page = await context.newPage();
  const second = await browser.newContext();
  const joiner = await second.newPage();

  await page.goto('/');
  await startGame(page, 'letras');
  await expect(page.getByTestId('status')).toContainText('Waiting for someone');
  await joiner.goto(await inviteLink(page));

  // Wait until the module is actually downloaded, or the card reads "not
  // downloaded" and the picture says the opposite of what it is there to say.
  await expect(page.getByRole('heading', { name: 'Letras' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });

  await page.goto('/settings');
  const card = page.locator('li[data-plugin="letras"]').first();
  await expect(card).toContainText('on this device');

  // The card sits below the identity and backup cards, so a plain screenshot
  // catches the top of the page and none of the thing it is meant to show.
  await card.scrollIntoViewIfNeeded();

  await page.screenshot({ path: `${OUT}/games.png` });
  await context.close();
  await second.close();
});
