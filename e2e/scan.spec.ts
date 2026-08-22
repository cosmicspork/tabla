/**
 * Reading a code with the camera, without a camera.
 *
 * `getUserMedia` is replaced with a canvas showing the QR the *app itself* drew
 * a moment earlier, captured as a stream. So the loop under test is the real
 * one — a video element, frames pulled off it, a decoder, the same parser the
 * paste box uses — and the only fake is the lens.
 *
 * This exercises the path an iPhone takes, on Linux. Headless Chromium has no
 * `BarcodeDetector` either, so the scanner falls through to the vendored jsQR
 * at `/qr/jsqr.mjs` — which also proves that file is served, imports cleanly,
 * and is reachable without being precached.
 */
import { expect, test, type Page } from '@playwright/test';

import { introduce, inviteLink, startGame } from './helpers.ts';

/**
 * Points the next page's camera at this image.
 *
 * Installed before any app code runs, so `scanningAvailable()` sees a camera
 * and the scanner gets a stream that is already painting.
 */
async function showToCamera(page: Page, pngDataUrl: string) {
  await page.addInitScript((source: string) => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        let image: HTMLImageElement | null = null;
        if (source) {
          image = new Image();
          image.src = source;
          await image.decode();
        }

        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 480;
        const context = canvas.getContext('2d')!;

        // Repainted continuously: a canvas stream only produces frames while
        // something is drawing to it, and a still frame is not a video.
        const paint = () => {
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          // Inset, so the code keeps the quiet zone a decoder needs. With no
          // image, the frame stays blank — a camera pointed at nothing.
          if (image) context.drawImage(image, 40, 40, 400, 400);
          requestAnimationFrame(paint);
        };
        paint();

        return canvas.captureStream(30);
      },
    });
  }, pngDataUrl);
}

/** A PNG of whatever QR this page is currently showing. */
async function codeOnScreen(page: Page, selector: string): Promise<string> {
  const shot = await page.locator(selector).screenshot();
  return `data:image/png;base64,${shot.toString('base64')}`;
}

test('an invite is joined by scanning it, without going near the browser', async ({ browser }) => {
  const host = await browser.newContext();
  const a = await host.newPage();
  await a.goto('/');
  await startGame(a);
  await expect(a.getByTestId('status')).toContainText('Waiting for someone');

  // The QR as the inviter's screen actually renders it.
  const code = await codeOnScreen(a, '.qr');
  // Sanity: the same invite as a link, so a failure here is about scanning
  // rather than about the game never having been created.
  expect(await inviteLink(a)).toContain('/j#');

  const guest = await browser.newContext();
  const b = await guest.newPage();
  await showToCamera(b, code);
  await b.goto('/');
  await introduce(b, 'Ada');

  // The whole point: no link was tapped, nothing was copied, Safari never came
  // into it. The code went from one screen into the app's own viewfinder.
  await b.getByRole('link', { name: 'Open a link someone sent me' }).click();
  await b.getByTestId('scan').click();

  await expect(b.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 30_000 });
  await expect(a.getByRole('heading', { name: 'Tic tac toe' })).toBeVisible({ timeout: 30_000 });

  await host.close();
  await guest.close();
});

test("a device link is read off the other device's screen", async ({ browser }) => {
  const one = await browser.newContext();
  const a = await one.newPage();
  await a.goto('/');
  await introduce(a, 'Ada');
  await a.goto('/settings/devices/link');
  await expect(a.getByTestId('link-words')).toBeVisible({ timeout: 30_000 });

  const words = await a.getByTestId('link-words').getAttribute('data-words');
  const code = await codeOnScreen(a, '.qr');

  const two = await browser.newContext();
  const b = await two.newPage();
  await showToCamera(b, code);
  await b.goto('/link');

  await b.getByTestId('scan').click();

  // The words land in the field the person would otherwise have typed them
  // into — the scan is a shortcut through the same form, not a second path.
  await expect(b.getByTestId('link-words-input')).toHaveValue(words!, { timeout: 30_000 });

  await one.close();
  await two.close();
});

test('the camera being refused is a sentence, not a dead end', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const error = new Error('denied');
        error.name = 'NotAllowedError';
        throw error;
      },
    });
  });

  await page.goto('/');
  await introduce(page, 'Ada');
  await page.getByRole('link', { name: 'Open a link someone sent me' }).click();
  await page.getByTestId('scan').click();

  await expect(page.getByText(/camera was not allowed/i)).toBeVisible();
  await page.getByTestId('scanner-dismiss').click();

  // Back to the box, which was always the route that needs no permission.
  await expect(page.getByTestId('paste-link')).toBeVisible();

  await context.close();
});

test('a camera pointed at nothing keeps looking, and shows what it sees', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await showToCamera(page, '');

  await page.goto('/');
  await introduce(page, 'Ada');
  await page.getByRole('link', { name: 'Open a link someone sent me' }).click();
  await page.getByTestId('scan').click();

  // The bug this replaced: a scanner that opened the camera but never put the
  // picture on the page, leaving the person aiming a lens they could not see.
  const viewfinder = page.getByTestId('scanner-video');
  await expect(viewfinder).toBeVisible();

  // A frame with no code in it is not a failure — it is the normal case, right
  // up until the moment it is not. The scanner stays up and keeps reading.
  await expect(viewfinder).toBeVisible({ timeout: 2000 });
  await expect(page.getByTestId('do-open')).toBeDisabled();

  await page.getByTestId('scanner-cancel').click();
  await expect(page.getByTestId('paste-link')).toBeVisible();
  await expect(viewfinder).toBeHidden();

  await context.close();
});
