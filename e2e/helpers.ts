/** Shared steps for the browser tests. */
import type { Page } from '@playwright/test';

/**
 * Starts a game of the named kind.
 *
 * There is more than one game now, so starting one is two taps: the button that
 * opens the picker, then the game itself.
 */
export async function startGame(page: Page, game = 'tictactoe'): Promise<void> {
  await page.getByRole('button', { name: 'Start a new game' }).click();
  await page.locator(`button[data-game="${game}"]`).click();
}

/** Reads the invite link out of the share panel. */
export async function inviteLink(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>('[data-invite-link]')?.dataset.inviteLink ?? '',
  );
}
