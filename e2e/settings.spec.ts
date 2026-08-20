/**
 * The settings hub.
 *
 * Not a tour of every page — each is small — but the two things a hub has to
 * get right: every row goes where it says, and the summaries under them are
 * read from the thing they describe rather than written down beside it.
 */
import { expect, test } from '@playwright/test';

import { introduce, inviteLink, startGame } from './helpers.ts';

test('every row opens the page it names, and back returns to the hub', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/settings');

  const rows: [string, string][] = [
    ['Profile', '/settings/profile'],
    ['People', '/settings/people'],
    ['Notifications', '/settings/notifications'],
    ['Appearance', '/settings/appearance'],
    ['Backup & restore', '/settings/backup'],
    ['Storage', '/settings/storage'],
    ['About', '/settings/about'],
  ];

  for (const [name, path] of rows) {
    await page.getByRole('link', { name: new RegExp(name.replace('&', '&')) }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    // The header names the page, and is the only heading on it.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);

    await page.getByTestId('nav-back').click();
    await expect(page).toHaveURL(/\/settings$/);
  }

  await context.close();
});

test('a theme choice outlasts a reload', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/settings/appearance');
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Stored, not just applied: the whole point is that it survives.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true');

  // And system hands the decision back to the device.
  await page.getByTestId('theme-system').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);

  await context.close();
});

test('renaming someone sticks, and the hub says so', async ({ browser }) => {
  const one = await browser.newContext();
  const two = await browser.newContext();

  const a = await one.newPage();
  await a.goto('/');
  await startGame(a);
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  const link = await a.evaluate(
    () => document.querySelector<HTMLElement>('[data-invite-link]')?.dataset.inviteLink ?? '',
  );

  const b = await two.newPage();
  await b.goto(link);
  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 20_000 });

  await a.goto('/settings/people');
  await a.getByRole('button', { name: 'Rename' }).click();
  await a.locator('input').fill('Pooja');
  await a.getByRole('button', { name: 'Save' }).click();
  await expect(a.getByText('Pooja')).toBeVisible();

  // The hub reads its summaries from the data, so it knows without being told.
  await a.goto('/settings');
  await expect(a.getByRole('link', { name: /People/ })).toContainText('Pooja');

  await one.close();
  await two.close();
});

test('a name travels to the other player, in both directions', async ({ browser }) => {
  const one = await browser.newContext();
  const two = await browser.newContext();

  const a = await one.newPage();
  const b = await two.newPage();

  // Both players say what they would like to be called before playing.
  await a.goto('/');
  await introduce(a, 'Ada');
  await b.goto('/');
  await introduce(b, 'Pooja');

  await a.getByRole('link', { name: 'Start a new game' }).click();
  await a.locator('button[data-game="tictactoe"]').click();
  await a.getByRole('button', { name: /Make an invite link/ }).click();
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  const link = await inviteLink(a);

  await b.goto(link);
  await expect(b.locator('.board button')).toHaveCount(9, { timeout: 20_000 });

  // The claimer learns the initiator's name from the sealed invite…
  await b.goto('/');
  await expect(b.getByText('Tic tac toe with Ada')).toBeVisible();

  // …and the initiator learns the claimer's from the game's own log, which is
  // the only place it could have come from: the relay never saw it.
  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 20_000 });
  await a.goto('/');
  await expect(a.getByText('Tic tac toe with Pooja')).toBeVisible({ timeout: 20_000 });

  await one.close();
  await two.close();
});

test('a game can be started against someone you have played before', async ({ browser }) => {
  const one = await browser.newContext();
  const two = await browser.newContext();

  const a = await one.newPage();
  const b = await two.newPage();

  await a.goto('/');
  await introduce(a, 'Ada');
  await b.goto('/');
  await introduce(b, 'Pooja');

  await a.getByRole('link', { name: 'Start a new game' }).click();
  await a.locator('button[data-game="tictactoe"]').click();
  await a.getByRole('button', { name: /Make an invite link/ }).click();
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  await b.goto(await inviteLink(a));
  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 20_000 });

  // Second game: they are on the list now, so it starts with who rather than
  // with a link nobody is addressed by.
  await a.goto('/new');
  await a.getByText('Pooja').click();
  await a.locator('button[data-game="tictactoe"]').click();
  await a.getByRole('button', { name: 'Invite Pooja' }).click();

  // Named from the moment it exists, before anyone has claimed anything.
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  await a.goto('/');
  await expect(a.getByText('Tic tac toe with Pooja')).toHaveCount(2);

  await one.close();
  await two.close();
});

test('a second game reaches someone without a link at all', async ({ browser }) => {
  const one = await browser.newContext();
  const two = await browser.newContext();

  const a = await one.newPage();
  const b = await two.newPage();

  await a.goto('/');
  await introduce(a, 'Ada');
  await b.goto('/');
  await introduce(b, 'Pooja');

  // The first game needs a link: there is no other way to reach a stranger.
  await a.getByRole('link', { name: 'Start a new game' }).click();
  await a.locator('button[data-game="tictactoe"]').click();
  await a.getByRole('button', { name: /Make an invite link/ }).click();
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  await b.goto(await inviteLink(a));
  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 20_000 });

  // The second does not. Ada invites Pooja and sends nothing.
  await a.goto('/new');
  await a.getByText('Pooja').click();
  await a.locator('button[data-game="tictactoe"]').click();
  await a.getByRole('button', { name: 'Invite Pooja' }).click();
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');

  // Pooja finds it waiting the next time she looks, in a mailbox only the two
  // of them can address.
  await b.goto('/');
  await expect(b.getByText('Invitations')).toBeVisible({ timeout: 20_000 });
  // Scoped to the invitation: she is already playing a tic tac toe with Ada,
  // which is the whole reason a mailbox between them exists.
  const invitation = b.locator('[data-invitation]');
  await expect(invitation).toContainText('Tic tac toe with Ada');

  await invitation.getByRole('button', { name: 'Play' }).click();
  await expect(b.locator('.board button')).toHaveCount(9, { timeout: 20_000 });

  // Taken up, so it is gone from the list rather than offered twice.
  await b.goto('/');
  await expect(b.getByText('Invitations')).toBeHidden();

  await one.close();
  await two.close();
});

test('an invitation can be turned down without spending it', async ({ browser }) => {
  const one = await browser.newContext();
  const two = await browser.newContext();

  const a = await one.newPage();
  const b = await two.newPage();

  await a.goto('/');
  await introduce(a, 'Ada');
  await b.goto('/');
  await introduce(b, 'Pooja');

  await a.getByRole('link', { name: 'Start a new game' }).click();
  await a.locator('button[data-game="tictactoe"]').click();
  await a.getByRole('button', { name: /Make an invite link/ }).click();
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  await b.goto(await inviteLink(a));
  await expect(a.locator('.board button')).toHaveCount(9, { timeout: 20_000 });

  await a.goto('/new');
  await a.getByText('Pooja').click();
  await a.locator('button[data-game="letras"]').click();
  await a.getByRole('button', { name: 'Invite Pooja' }).click();
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');

  await b.goto('/');
  await expect(b.getByText('Invitations')).toBeVisible({ timeout: 20_000 });
  await b.getByRole('button', { name: 'No thanks' }).click();

  // Gone from her list, and not claimed: declining is forgetting, not spending
  // somebody's single-use invite.
  await expect(b.getByText('Invitations')).toBeHidden();
  await b.reload();
  await expect(b.getByText('Invitations')).toBeHidden();

  await one.close();
  await two.close();
});
