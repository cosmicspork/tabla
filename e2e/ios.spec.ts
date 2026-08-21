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

import { introduce, inviteLink, startGame } from './helpers.ts';

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
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');

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
  await expect(page.getByTestId('status')).toContainText('Waiting for someone');

  // The app has loaded, created a game, and rendered — and still not asked.
  expect(asked).toBe(false);

  await context.close();
});

test('the app still opens with no network at all', async ({ browser }) => {
  const context = await browser.newContext(iPhone);
  const page = await context.newPage();

  await page.goto('/');
  // A device that has been used before, which is the one that ends up offline.
  await introduce(page, 'Ada');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  // A second load so the shell is served by the worker that is now in control.
  await page.reload();

  await context.setOffline(true);
  await page.reload();

  // The shell is there and interactive, served entirely by the service worker,
  // and it still knows who this device is — the identity is local, so nothing
  // about opening the app needs the network.
  await expect(page.getByRole('link', { name: 'Start a new game' })).toBeVisible();

  await context.setOffline(false);
  await context.close();
});

/**
 * Where a link opened, and what it cost to find out.
 *
 * On iOS a link never reaches the installed app: a tapped URL or a scanned code
 * opens Safari, and Safari cannot see what the Home Screen app keeps. Redeeming
 * one there is not a wrong window but a lost invite — it works exactly once, and
 * spending it also generates the identity that spends it. So the browser tab
 * asks before it takes anything, and the two contexts below stand in for the two
 * storage containers, which is what they are.
 */
test('an invite opened in an iOS browser tab is not spent there', async ({ browser }) => {
  const host = await browser.newContext();
  const a = await host.newPage();
  await a.goto('/');
  await startGame(a);
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  const link = await inviteLink(a);

  // Safari, where the link landed.
  const safari = await browser.newContext(iPhone);
  const b = await safari.newPage();
  await b.goto(link);

  await expect(b.getByTestId('join-already-play')).toBeVisible();
  await b.getByTestId('join-already-play').click();
  // The whole link, on screen and ready to be carried across.
  await expect(b.getByTestId('handoff-carry')).toContainText('#');

  // Nothing was taken: no identity was generated here, so this is still a
  // browser that has never seen tabla.
  await b.goto('/');
  await expect(b.getByTestId('new-here')).toBeVisible();

  // And the invite is still there for the app it was meant for. A separate
  // context, because separate storage is exactly what makes this a problem.
  const installed = await browser.newContext(iPhone);
  const c = await installed.newPage();
  await c.goto('/?simulate=ios-standalone');
  // The flag is recorded once the app has started, so wait for it to have
  // started before navigating away from the URL carrying it.
  await expect(c.getByTestId('new-here')).toBeVisible();
  await c.goto(link);

  await expect(c.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 20_000 });
  await expect(a.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 20_000 });

  await host.close();
  await safari.close();
  await installed.close();
});

test('someone genuinely new can still join from the tab they landed in', async ({ browser }) => {
  const host = await browser.newContext();
  const a = await host.newPage();
  await a.goto('/');
  await startGame(a);
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  const link = await inviteLink(a);

  const safari = await browser.newContext(iPhone);
  const b = await safari.newPage();
  await b.goto(link);

  // The question costs one tap, and answering it the other way costs nothing
  // else: this is how most people meet tabla.
  await b.getByTestId('join-new-here').click();
  await expect(b.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 20_000 });

  await host.close();
  await safari.close();
});

test('a link that opened in the wrong browser can be carried in by hand', async ({ browser }) => {
  const host = await browser.newContext();
  const a = await host.newPage();
  await a.goto('/');
  await startGame(a);
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');
  const link = await inviteLink(a);

  const installed = await browser.newContext(iPhone);
  const b = await installed.newPage();
  await b.goto('/?simulate=ios-standalone');
  await introduce(b, 'Ada');

  await b.getByRole('link', { name: 'Open a link someone sent me' }).click();
  await b.getByTestId('paste-link').fill(link);
  await b.getByTestId('do-open').click();

  await expect(b.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 20_000 });
  await expect(a.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 20_000 });

  await host.close();
  await installed.close();
});
