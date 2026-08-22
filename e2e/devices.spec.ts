/**
 * Playing the same games from two devices.
 *
 * A third browser context is a third device in every way that matters here: its
 * own storage, its own service worker, its own idea of who it is. The link is
 * what makes it the same person as the first, and everything after that is
 * about the two of them agreeing without the relay learning that they are a
 * pair — which it cannot, because it never sees the words.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  gameWhereMoverCanSpell,
  introduce,
  inviteLink,
  onTurn,
  playWord,
  startGame,
} from './helpers.ts';

/** Sets up a played game between two people, and returns the initiator's page. */
async function playedGame(browser: Browser) {
  const one = await browser.newContext();
  const two = await browser.newContext();
  const a = await one.newPage();
  const b = await two.newPage();

  // Both say what they would like to be called before playing, so the link
  // later has a real name to carry.
  await a.goto('/');
  await introduce(a, 'Josh');
  await b.goto('/');
  await introduce(b, 'Pooja');

  await startGame(a, 'tictactoe');
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  const link = await inviteLink(a);

  await b.goto(link);
  await expect(b.locator('.board button')).toHaveCount(9, { timeout: 30_000 });

  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 30_000 });
  await a.locator('.board button').first().click();
  await expect(b.locator('.board button').first()).not.toBeEmpty({ timeout: 30_000 });

  return { one, two, a, b };
}

/** Offers a link on `page` and returns the words it shows. */
async function offer(page: Page): Promise<string> {
  await page.goto('/settings/devices');
  await page.getByTestId('link-device').click();

  const words = page.getByTestId('link-words');
  await expect(words).toBeVisible({ timeout: 30_000 });
  // From the attribute rather than the text: the words are separate elements,
  // and reading them as one string runs them together.
  return (await words.getAttribute('data-words')) ?? '';
}

/** Takes a link on a fresh device and waits for it to land. */
async function take(page: Page, words: string, name: string) {
  await page.goto('/link');
  await page.getByTestId('link-words-input').fill(words);
  await page.getByTestId('device-name').fill(name);
  await page.getByTestId('do-link').click();

  await expect(page.getByRole('link', { name: 'Start a new game' })).toBeVisible({
    timeout: 30_000,
  });
}

test('a second device links and arrives holding the games', async ({ browser }) => {
  const { one, two, a } = await playedGame(browser);
  const words = await offer(a);

  // Six words, all from the list, and nothing else needed to carry them.
  expect(words.split(' ')).toHaveLength(6);

  const three = await browser.newContext();
  const c = await three.newPage();
  await take(c, words, 'Laptop');

  // The game is there, named as the same opponent, without the laptop ever
  // having met her.
  await expect(c.getByText(/Tic tac toe with Pooja/)).toBeVisible({ timeout: 30_000 });

  // And it is the same player: the fingerprint an opponent would check.
  await a.goto('/settings/profile');
  const mine = a.locator('.print').first();
  await expect(mine).not.toHaveText('…', { timeout: 30_000 });

  await c.goto('/settings/profile');
  await expect(c.locator('.print').first()).toHaveText((await mine.textContent()) ?? '', {
    timeout: 30_000,
  });

  await one.close();
  await two.close();
  await three.close();
});

test('a link works once and then does not', async ({ browser }) => {
  const { one, two, a } = await playedGame(browser);
  const words = await offer(a);

  const three = await browser.newContext();
  const c = await three.newPage();
  await take(c, words, 'Laptop');

  // Anyone who overheard the words is too late, which is the property that
  // makes reading them out loud reasonable in the first place.
  const four = await browser.newContext();
  const d = await four.newPage();
  await d.goto('/link');
  await d.getByTestId('link-words-input').fill(words);
  await d.getByTestId('device-name').fill('Eavesdropper');
  await d.getByTestId('do-link').click();

  await expect(d.getByText(/already used that link/)).toBeVisible({ timeout: 30_000 });

  await one.close();
  await two.close();
  await three.close();
  await four.close();
});

test('words that are not on the list are refused before anything is sent', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/link');
  await page.getByTestId('link-words-input').fill('abandon ability able about above zzzzz');

  await expect(page.getByTestId('unknown-words')).toContainText('zzzzz');
  await expect(page.getByTestId('do-link')).toBeDisabled();

  await context.close();
});

test('each device shows up on the other’s list, and can be removed', async ({ browser }) => {
  const { one, two, a } = await playedGame(browser);
  const words = await offer(a);

  const three = await browser.newContext();
  const c = await three.newPage();
  await take(c, words, 'Laptop');

  // The laptop announced itself; the phone reads its own mailbox when the
  // devices page is opened, which is when somebody wants to know.
  await a.goto('/settings/devices');
  const listed = a.locator('a[data-device]');
  await expect(listed).toHaveCount(1, { timeout: 30_000 });
  await expect(listed).toContainText('Laptop');

  // Removing it tells it to stop. It finds out from its own mailbox.
  a.on('dialog', (dialog) => void dialog.accept());
  await listed.click();
  await a.getByTestId('remove-device').click();
  await expect(a.locator('a[data-device]')).toHaveCount(0, { timeout: 30_000 });

  await c.goto('/');
  await expect(c.getByTestId('removed')).toBeVisible({ timeout: 30_000 });

  await one.close();
  await two.close();
  await three.close();
});

test('a game started on one device appears on the other', async ({ browser }) => {
  const { one, two, a } = await playedGame(browser);
  const words = await offer(a);

  const three = await browser.newContext();
  const c = await three.newPage();
  await take(c, words, 'Laptop');

  // Started on the laptop, which the phone has never been told about directly.
  await startGame(c, 'letras');
  await expect(c.getByTestId('status')).toContainText('Waiting for someone');

  await a.goto('/');
  await expect(a.getByText(/Letras/)).toBeVisible({ timeout: 30_000 });

  await one.close();
  await two.close();
  await three.close();
});

test('a move being built on one device locks the board on the other', async ({ browser }) => {
  const { one, two, a, b } = await playedGame(browser);
  const words = await offer(a);

  const three = await browser.newContext();
  const c = await three.newPage();
  await take(c, words, 'Laptop');

  // A word game, because it is the one with a staging step: tic tac toe has no
  // moment between deciding and playing for a device to claim anything in.
  await a.goto('/');
  await startGame(a, 'letras');
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  const link = await inviteLink(a);
  await b.goto(link);

  await expect(a.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });

  // The deal writes entries of its own, so who moves first is not fixed. If it
  // is the opponent, they pass — the turn is what this test is about, not the
  // word.
  const [mover] = await onTurn(a, b);
  if (mover !== a) {
    await b.getByRole('button', { name: 'Pass' }).click();
    await expect(a.getByText('Your turn.')).toBeVisible({ timeout: 30_000 });
  }

  // Open the same game on the laptop, which is the same player.
  await c.goto('/');
  const row = c.getByRole('link', { name: /Letras/ });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(c.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });

  // Start building a word on the phone.
  await a.locator('.rack .tile').first().click();
  await a.locator('[data-cell="112"]').click();

  // The laptop says where the move is being made, and does not offer to take it
  // over: nothing is wrong, and interrupting yourself from another room is not
  // a thing worth having a button for.
  await expect(c.getByTestId('status')).toContainText(/mid-move on/, { timeout: 30_000 });
  await expect(c.getByRole('button', { name: 'Play here instead' })).toBeHidden();
  await expect(c.locator('.word-board.waiting')).toBeVisible();

  // Taking the tiles back gives the turn up again.
  await a.getByRole('button', { name: 'Recall' }).click();
  await expect(c.getByTestId('status')).not.toContainText(/mid-move on/, { timeout: 30_000 });

  await one.close();
  await two.close();
  await three.close();
});

/**
 * The other half of that claim: the device that made it.
 *
 * The relay hands whatever claim it is holding to a socket that has just said
 * hello, which is how a device joining late finds out that another is already
 * mid-move. It cannot tell one of this person's devices from another — the
 * body is sealed, and only the devices can read it — so a device that
 * reconnects while its own claim is still standing is handed that claim back.
 * Believing it locked the board against the player in front of it: their own
 * tiles out of reach, and nothing but leaving the screen and coming back to
 * clear it.
 *
 * One device here, and no link: this is a game with itself.
 */
test('a device is not locked out by its own claim on the turn', async ({ browser }) => {
  const { one, two, mover, other, indices } = await gameWhereMoverCanSpell(browser, true);

  // A tile down is what claims the turn at the relay, for two minutes.
  await mover.locator('.rack .tile').nth(indices[0]).click();
  await mover.locator('[data-cell="112"]').click();
  await expect(mover.locator('.square.staged')).toHaveCount(1);

  // And then the socket goes without the claim being given back. A reload does
  // it here; in life it is a pocket, a tunnel, or iOS taking the app away. The
  // relay keeps the claim through all of them — a claim is meant to outlive a
  // dropped connection, or it would be no use to the device that made it.
  await mover.reload();
  await expect(mover.locator('[data-rack]')).toHaveAttribute('data-rack', /^.{7}$/, {
    timeout: 30_000,
  });

  // The board is the player's again on the other side of that, and stays that
  // way: playing a whole word is what proves the claim was handed back and
  // recognised, because every part of it needs a board that takes taps.
  await expect(mover.locator('[data-cell="112"]')).toBeEnabled();
  await playWord(mover, indices);
  await expect(other.locator('.square.filled')).toHaveCount(indices.length, { timeout: 30_000 });
  await expect(mover.getByTestId('status')).not.toContainText(/mid-move on/);

  await one.close();
  await two.close();
});
