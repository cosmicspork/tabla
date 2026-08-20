/**
 * The phase 1 acceptance run, in real browsers.
 *
 * Two independent browser contexts — separate origins' storage, separate
 * identities, exactly like two phones — create an invite, redeem it, and play a
 * game to a result through the relay.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { startGame } from './helpers.ts';

/** A fresh profile: its own IndexedDB, so its own identity keypair. */
async function newPlayer(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.goto('/');
  return page;
}

async function readInviteLink(page: Page): Promise<string> {
  // The share button copies it, but reading the rendered link is less flaky
  // than depending on clipboard permissions.
  await expect(page.getByTestId('status')).toContainText('Waiting for someone');

  return page.evaluate(() => {
    const game = location.pathname.split('/').pop() ?? '';
    void game;
    // The page renders the QR from the same string it would share.
    return (
      document.querySelector<HTMLElement>('[data-invite-link]')?.dataset.inviteLink ?? ''
    );
  });
}

test('two players complete a game through the relay', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();

  const a = await newPlayer(alice);
  const b = await newPlayer(bob);

  // Alice starts a game and gets a single-use link.
  await startGame(a);
  const link = await readInviteLink(a);
  expect(link).toContain('/j#');

  // Bob redeems it in a completely separate profile.
  await b.goto(link);
  await expect(b.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible();

  // Alice's page notices the claim on its own and moves to the board.
  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 20_000 });

  // Alice is X and moves first.
  await expect(a.getByText('Your turn.')).toBeVisible();
  await expect(b.getByText('Waiting for your opponent.')).toBeVisible();

  // Alice takes the top row; Bob answers along the middle-left.
  const cellsFor = (page: Page) => page.locator('.board button');

  for (const [mover, other, cell] of [
    [a, b, 0],
    [b, a, 3],
    [a, b, 1],
    [b, a, 4],
    [a, b, 2],
  ] as const) {
    await expect(mover.getByText('Your turn.')).toBeVisible();
    await cellsFor(mover).nth(cell).click();
    // The move reaches the opponent over the live socket.
    await expect(other.locator('.board button').nth(cell)).not.toBeEmpty();
  }

  await expect(a.getByText('You won.')).toBeVisible();
  await expect(b.getByText('You lost.')).toBeVisible();

  await alice.close();
  await bob.close();
});

test('an invite link can only be used once', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const carol = await browser.newContext();

  const a = await newPlayer(alice);
  await startGame(a);
  const link = await readInviteLink(a);

  const b = await newPlayer(bob);
  await b.goto(link);
  await expect(b.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible();

  // Carol tries the same link. It is a bearer token, and it is spent.
  const c = await newPlayer(carol);
  await c.goto(link);
  await expect(c.getByTestId('status')).toContainText('Could not join');
  await expect(c.getByText(/already been used/)).toBeVisible();

  await alice.close();
  await bob.close();
  await carol.close();
});

test('a game survives the relay losing its copy', async ({ browser, request }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();

  const a = await newPlayer(alice);
  await startGame(a);
  const link = await readInviteLink(a);
  const gameId = new URL(a.url()).pathname.split('/').pop()!;

  const b = await newPlayer(bob);
  await b.goto(link);
  await expect(a.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 20_000 });

  await a.locator('.board button').nth(4).click();
  await expect(b.locator('.board button').nth(4)).not.toBeEmpty();

  // Wipe the relay's stored ciphertext, as the ninety-day retention alarm does.
  const wiped = await request.post(`/api/_test/wipe/${gameId}`);
  expect(wiped.ok()).toBeTruthy();

  // Reloading re-uploads the log from the client that still has it, and play
  // continues. The tombstone is satisfied because the log really does extend it.
  await a.reload();
  await b.reload();
  await expect(b.getByText('Your turn.')).toBeVisible({ timeout: 20_000 });

  await b.locator('.board button').nth(0).click();
  await expect(a.locator('.board button').nth(0)).not.toBeEmpty({ timeout: 20_000 });

  await alice.close();
  await bob.close();
});

test('resigning is reported as resigning, to both players', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();

  const a = await newPlayer(alice);
  const b = await newPlayer(bob);

  await startGame(a);
  const link = await readInviteLink(a);
  await b.goto(link);
  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 20_000 });

  // The confirmation is the whole point of an irreversible control.
  a.on('dialog', (dialog) => dialog.accept());
  await a.getByRole('button', { name: 'Resign' }).click();

  // A resignation is a win for somebody, but neither player is told they
  // played it out.
  await expect(a.getByTestId('status')).toContainText('You resigned.');
  await expect(b.getByTestId('status')).toContainText('They resigned.', { timeout: 20_000 });

  // And the game list agrees with the board.
  await a.goto('/');
  await expect(a.getByText('You resigned')).toBeVisible();

  await alice.close();
  await bob.close();
});

test('an invite nobody took can be called off, and the link dies with it', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();

  const a = await newPlayer(alice);
  await startGame(a);
  const link = await readInviteLink(a);

  a.on('dialog', (dialog) => dialog.accept());
  await a.getByRole('button', { name: 'Cancel invite' }).click();

  // Back on the list, with nothing left behind.
  await expect(a.getByRole('heading', { name: 'Your games' })).toBeVisible();
  await expect(a.getByText('Waiting for someone to join')).toBeHidden();

  // And the link is dead for whoever still has it — a local delete alone would
  // have left a live invite out there, redeemable into a game with nobody on
  // the other end.
  const b = await newPlayer(bob);
  await b.goto(link);
  await expect(b.getByTestId('status')).toContainText('Could not join');

  await alice.close();
  await bob.close();
});
