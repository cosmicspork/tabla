/**
 * The word game, played between two real browser profiles.
 *
 * These tests do something the Rust tests cannot: they check that the whole
 * pipe holds when the two halves of a game are genuinely separate. Each profile
 * has its own identity, its own IndexedDB, and — crucially — its own draw
 * secret, so the tiles one of them holds are not merely hidden from the other
 * but genuinely unknown to it.
 *
 * The word list is fetched over the network here for real, from the relay's
 * static assets, and hash-checked before it reaches the sandbox.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { inviteLink, startGame } from './helpers.ts';

/** The same list the app ships, so the tests agree with the rules about words. */
const WORDS = new Set(
  readFileSync(fileURLToPath(new URL('../wordlist/enable.txt', import.meta.url)), 'utf8')
    .split('\n')
    .filter(Boolean),
);

/** Sets up a Letras game between two fresh profiles, both ready to play. */
async function letrasGame(browser: BrowserContext['browser']) {
  const one = await browser!.newContext();
  const two = await browser!.newContext();

  const a = await one.newPage();
  await a.goto('/');
  await startGame(a, 'letras');

  await expect(a.getByRole('heading', { name: 'Waiting for a player' })).toBeVisible();
  const link = await inviteLink(a);

  const b = await two.newPage();
  await b.goto(link);

  // Both boards appear, which means both fetched and verified the word list.
  await expect(a.getByRole('heading', { name: 'Letras' })).toBeVisible({ timeout: 30_000 });
  await expect(b.getByRole('heading', { name: 'Letras' })).toBeVisible({ timeout: 30_000 });

  // And both got through the opening: commitments, the toss, and the deal.
  await expect(a.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });
  await expect(b.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });

  return { one, two, a, b };
}

/**
 * A game whose player on turn can spell what the test needs.
 *
 * Tiles are dealt, not chosen, so a rack sometimes cannot make a real word at
 * all — seven consonants happen. Rather than skip and lose the coverage, deal
 * again: each attempt is a few seconds, and two failures in a row are already
 * unlikely.
 */
async function gameWhereMoverCanSpell(browser: BrowserContext['browser'], real: boolean) {
  const attempts = [];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const table = await letrasGame(browser);
    const [mover, other] = await onTurn(table.a, table.b);
    const rack = await rackOf(mover);
    const indices = wordFromRack(rack, real);

    if (indices) return { ...table, mover, other, indices };

    attempts.push(rack);
    await table.one.close();
    await table.two.close();
  }

  throw new Error(
    `no rack in four deals could spell ${real ? 'a word' : 'a non-word'}: ${attempts.join(', ')}`,
  );
}

/** Whichever page is on turn. */
async function onTurn(a: Page, b: Page): Promise<[Page, Page]> {
  await expect
    .poll(async () => (await a.getByText('Your turn.').count()) + (await b.getByText('Your turn.').count()), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  return (await a.getByText('Your turn.').count()) > 0 ? [a, b] : [b, a];
}

async function rackOf(page: Page): Promise<string> {
  return (await page.locator('[data-rack]').getAttribute('data-rack')) ?? '';
}

/**
 * Finds an arrangement of these tiles that is — or is not — a word.
 *
 * The tiles are dealt by the draw protocol, not chosen, so a test that wants a
 * particular kind of word has to search what it was given. Real words are
 * looked for shortest first, because two-letter words are common and a random
 * five-letter arrangement almost never is; fake ones the other way round, for
 * the same reason.
 */
function wordFromRack(rack: string, real: boolean): number[] | null {
  const letters = [...rack].map((c) => (c === '?' ? 'e' : c));
  const lengths = [...Array(Math.min(7, letters.length) - 1).keys()].map((i) => i + 2);

  for (const length of real ? lengths : [...lengths].reverse()) {
    for (const order of arrangements([...letters.keys()], length)) {
      const word = order.map((i) => letters[i]).join('');
      if (WORDS.has(word) === real) return order;
    }
  }
  return null;
}

/** Every ordered selection of `length` of these indices. */
function* arrangements(pool: number[], length: number): Generator<number[]> {
  if (length === 0) {
    yield [];
    return;
  }
  for (let i = 0; i < pool.length; i += 1) {
    const rest = [...pool.slice(0, i), ...pool.slice(i + 1)];
    for (const tail of arrangements(rest, length - 1)) yield [pool[i], ...tail];
  }
}

/** Taps rack tiles onto the centre row, left to right, and plays them. */
async function playWord(page: Page, indices: number[]) {
  const startCol = 7;

  for (const [offset, index] of indices.entries()) {
    await page.locator('.rack .tile').nth(index).click();
    await page.locator(`[data-cell="${7 * 15 + startCol + offset}"]`).click();

    // A blank asks what it stands for; `e` will do.
    const chooser = page.locator('.chooser');
    if (await chooser.isVisible()) await chooser.getByRole('button', { name: 'e' }).click();
  }

  await page.getByRole('button', { name: 'Play' }).click();
}

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

test('a word that is not a word can be challenged off the board', async ({ browser }) => {
  const { one, two, mover, other: challenger, indices } = await gameWhereMoverCanSpell(
    browser,
    false,
  );

  await playWord(mover, indices);
  await expect(challenger.locator('.square.filled')).toHaveCount(indices.length, {
    timeout: 30_000,
  });

  await challenger.getByRole('button', { name: 'Challenge' }).click();

  // The play comes back off both boards, and the challenger keeps the turn.
  await expect(mover.locator('.square.filled')).toHaveCount(0, { timeout: 30_000 });
  await expect(challenger.locator('.square.filled')).toHaveCount(0, { timeout: 30_000 });
  await expect(challenger.getByText('Your turn.')).toBeVisible({ timeout: 30_000 });

  await one.close();
  await two.close();
});

test('a real word survives a challenge and costs the challenger their turn', async ({
  browser,
}) => {
  const { one, two, mover, other: challenger, indices } = await gameWhereMoverCanSpell(
    browser,
    true,
  );

  await playWord(mover, indices);
  await expect(challenger.locator('.square.filled')).toHaveCount(indices.length, {
    timeout: 30_000,
  });

  await challenger.getByRole('button', { name: 'Challenge' }).click();

  // The tiles stay, and the turn comes back round to the player who placed them.
  await expect(challenger.locator('.square.filled')).toHaveCount(indices.length);
  await expect(mover.getByText('Your turn.')).toBeVisible({ timeout: 30_000 });

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
  await mover.goto('/settings');
  await mover.getByLabel('Passphrase').first().fill('correct horse battery staple');
  const download = mover.waitForEvent('download');
  await mover.getByRole('button', { name: 'Download backup' }).click();
  const file = await (await download).path();

  // A brand new profile: different identity, empty database.
  const replacement = await browser!.newContext();
  const c = await replacement.newPage();
  await c.goto('/settings');
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
