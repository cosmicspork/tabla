/**
 * The installed-iOS-PWA constraint set.
 *
 * iOS is the platform that shapes this design: push works only once the app is
 * on the Home Screen, permission must come from a user gesture, and there is no
 * Background Sync. These tests emulate an iPhone to check the app tells the
 * truth about that rather than raising a prompt that could never work.
 *
 * What they cannot do is prove delivery — that needs real hardware, and is a
 * manual checklist item in the README.
 */
import { devices, expect, test, type Browser, type Page } from '@playwright/test';

import { startGame } from './helpers.ts';

/**
 * iPhone characteristics only. The full device descriptor carries
 * `defaultBrowserType`, which Playwright refuses inside a file that also runs
 * desktop contexts.
 */
const iPhone = {
  userAgent: devices['iPhone 15'].userAgent,
  viewport: devices['iPhone 15'].viewport,
  deviceScaleFactor: devices['iPhone 15'].deviceScaleFactor,
  isMobile: devices['iPhone 15'].isMobile,
  hasTouch: devices['iPhone 15'].hasTouch,
};

/** Starts a game on an iPhone and has a second profile join it. */
async function gameOnIphone(browser: Browser, startUrl: string) {
  const host = await browser.newContext(iPhone);
  const guest = await browser.newContext();

  const a = await host.newPage();
  await a.goto(startUrl);
  await startGame(a);
  // Wait for the invite to render before reading it out.
  await expect(a.getByRole('heading', { name: 'Waiting for a player' })).toBeVisible();

  const link = await a.evaluate(
    () => document.querySelector<HTMLElement>('[data-invite-link]')?.dataset.inviteLink ?? '',
  );

  const b = await guest.newPage();
  await b.goto(link);
  await expect(a.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 20_000 });

  return { host, guest, a, b };
}

test('an iPhone in a browser tab is walked through installing', async ({ browser }) => {
  const { host, guest, a } = await gameOnIphone(browser, '/');

  // Push cannot work in an iOS tab, so offering it would be a lie.
  await expect(a.getByRole('heading', { name: /Add tabla to your Home Screen/ })).toBeVisible();
  await expect(a.getByRole('button', { name: /Turn on notifications/ })).toBeHidden();

  await host.close();
  await guest.close();
});

test('an installed iPhone app is past the install gate', async ({ browser }) => {
  // `?simulate=ios-standalone` stands in for having been added to the Home
  // Screen, which a test cannot actually do.
  //
  // What is checked is the gate itself: installed, the app no longer tells you
  // to install. Whether it then shows the offer or a "blocked" message depends
  // on the browser's notification permission, and headless Chromium pins that
  // to denied no matter what the test grants — so asserting on the button would
  // be asserting on the harness rather than on the app.
  const { host, guest, a } = await gameOnIphone(browser, '/?simulate=ios-standalone');

  await expect(a.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible();
  await expect(a.getByRole('heading', { name: /Add tabla to your Home Screen/ })).toBeHidden();

  await host.close();
  await guest.close();
});

test('permission is never requested without a tap', async ({ browser }) => {
  const context = await browser.newContext(iPhone);
  const page: Page = await context.newPage();

  let asked = false;
  await context.exposeFunction('__permissionAsked', () => {
    asked = true;
  });
  await page.addInitScript(() => {
    const original = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = (async (...args: unknown[]) => {
      (window as unknown as { __permissionAsked: () => void }).__permissionAsked();
      return original(...(args as []));
    }) as typeof Notification.requestPermission;
  });

  await page.goto('/?simulate=ios-standalone');
  await startGame(page);
  await expect(page.getByRole('heading', { name: 'Waiting for a player' })).toBeVisible();

  // The app has loaded, created a game, and rendered — and still not asked.
  expect(asked).toBe(false);

  await context.close();
});

test('the app still opens with no network at all', async ({ browser }) => {
  const context = await browser.newContext(iPhone);
  const page = await context.newPage();

  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  // A second load so the shell is served by the worker that is now in control.
  await page.reload();

  await context.setOffline(true);
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Your games' })).toBeVisible();

  await context.setOffline(false);
  await context.close();
});
