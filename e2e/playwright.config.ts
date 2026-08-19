import { defineConfig, devices } from '@playwright/test';

const PORT = 8787;

/**
 * Runs against the *built* app served by the relay Worker, not the Vite dev
 * server. That is the only configuration where the service worker, the install
 * prompt, and push behave as they will in production.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  // Generous: a word game test opens two browser profiles from scratch, and
  // each of them downloads and hash-checks a half-megabyte word list before it
  // can render a board.
  timeout: 120_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: undefined } }],

  webServer: {
    // `just build` first: the Worker serves app/build as static assets.
    // The wipe endpoint is dev-only and off by default, so enable it here.
    // Throwaway VAPID keys so the notification UI has something to offer; the
    // wipe endpoint is dev-only and off by default.
    command: [
      'bunx wrangler dev --port 8787',
      '--var TABLA_TEST_ENDPOINTS:true',
      '--var VAPID_SUBJECT:mailto:tests@tabla.invalid',
      '--var VAPID_PUBLIC_KEY:BIDXmumdfsiZPy2txPb8QGYvBw3NhTT007jCFFtnMjbIzl70LyaemszVUkk0Li5v8KocHDEQET9jXOLaiWPdRdU',
      '--var VAPID_PRIVATE_KEY:qnDPmxTwbcx22FeqwG-ygCWHLje_yAojv2hquHBGsyY',
    ].join(' '),
    cwd: '../worker',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
