/** Shared steps for the browser tests. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Gets past first run.
 *
 * Every test that is not about onboarding wants a device that already has an
 * identity, and the welcome screen stands in front of everything else until
 * one exists.
 */
export async function introduce(page: Page, name = ''): Promise<void> {
  const start = page.getByTestId('start-playing');
  const home = page.getByRole('link', { name: 'Start a new game' });

  // Wait for whichever of the two this device is going to show. Asking whether
  // the welcome screen is present without waiting for either races the first
  // paint, and answers "no" for a device that is about to show it.
  await expect(start.or(home).first()).toBeVisible();
  if (!(await start.isVisible())) return;

  if (name) await page.getByTestId('display-name').fill(name);
  await start.click();
  await expect(home).toBeVisible();
}

/**
 * Starts a game of the named kind, against nobody in particular.
 *
 * Three taps now: starting a game asks who before what, and the last step is
 * the one that creates the invite.
 */
export async function startGame(page: Page, game = 'tictactoe'): Promise<void> {
  await introduce(page);
  await page.getByRole('link', { name: 'Start a new game' }).click();
  await page.locator(`button[data-game="${game}"]`).click();
  await page.getByRole('button', { name: /Invite|Make an invite link/ }).click();
}

/** Reads the invite link out of the share panel. */
export async function inviteLink(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>('[data-invite-link]')?.dataset.inviteLink ?? '',
  );
}

/** The same list the app ships, so the tests agree with the rules about words. */
const WORDS = new Set(
  readFileSync(fileURLToPath(new URL('../wordlist/enable.txt', import.meta.url)), 'utf8')
    .split('\n')
    .filter(Boolean),
);

/** Sets up a Letras game between two fresh profiles, both ready to play. */
export async function letrasGame(browser: BrowserContext['browser']) {
  const one = await browser!.newContext();
  const two = await browser!.newContext();

  const a = await one.newPage();
  await a.goto('/');
  await startGame(a, 'letras');

  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
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
export async function gameWhereMoverCanSpell(
  browser: BrowserContext['browser'],
  real: boolean,
  prefer: 'short' | 'long' = 'short',
) {
  const attempts = [];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const table = await letrasGame(browser);
    const [mover, other] = await onTurn(table.a, table.b);
    const rack = await rackOf(mover);
    const indices = wordFromRack(rack, real, prefer);

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
export async function onTurn(a: Page, b: Page): Promise<[Page, Page]> {
  await expect
    .poll(async () => (await a.getByText('Your turn.').count()) + (await b.getByText('Your turn.').count()), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  return (await a.getByText('Your turn.').count()) > 0 ? [a, b] : [b, a];
}

export async function rackOf(page: Page): Promise<string> {
  return (await page.locator('[data-rack]').getAttribute('data-rack')) ?? '';
}

/**
 * Finds an arrangement of these tiles that is — or is not — a word.
 *
 * The tiles are dealt, not chosen, so a test that wants a particular kind of
 * word has to search what it was given. Real words are looked for shortest
 * first by default, because two-letter words are common and a random
 * five-letter arrangement almost never is; fake ones the other way round, for
 * the same reason. `prefer: 'long'` inverts that for the screenshots, where a
 * two-letter word makes a thin picture.
 */
export function wordFromRack(
  rack: string,
  real: boolean,
  prefer: 'short' | 'long' = 'short',
): number[] | null {
  const letters = [...rack].map((c) => (c === '?' ? 'e' : c));
  const lengths = [...Array(Math.min(7, letters.length) - 1).keys()].map((i) => i + 2);

  // Long-first costs real time — the search is over arrangements, so it grows
  // fast — and is only worth it when the picture matters more than the clock.
  const order = prefer === 'long' ? [...lengths].reverse() : lengths;

  for (const length of real ? order : [...lengths].reverse()) {
    for (const order of arrangements([...letters.keys()], length)) {
      const word = order.map((i) => letters[i]).join('');
      if (WORDS.has(word) === real) return order;
    }
  }
  return null;
}

/** Every ordered selection of `length` of these indices. */
export function* arrangements(pool: number[], length: number): Generator<number[]> {
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
export async function playWord(page: Page, indices: number[]) {
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
