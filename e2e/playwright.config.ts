import { defineConfig, devices } from '@playwright/test';

const PORT = 8787;

/**
 * The relay, exactly as the tests need it.
 *
 * `just build` runs first: the Worker serves `app/build` as static assets. The
 * wipe endpoint is dev-only and off by default, so it is enabled here, and the
 * VAPID keys are throwaways that exist only so the notification UI has
 * something to offer.
 */
const relay = [
  `bunx wrangler dev --port ${PORT}`,
  '--var TABLA_TEST_ENDPOINTS:true',
  '--var VAPID_SUBJECT:mailto:tests@tabla.invalid',
  '--var VAPID_PUBLIC_KEY:BIDXmumdfsiZPy2txPb8QGYvBw3NhTT007jCFFtnMjbIzl70LyaemszVUkk0Li5v8KocHDEQET9jXOLaiWPdRdU',
  '--var VAPID_PRIVATE_KEY:qnDPmxTwbcx22FeqwG-ygCWHLje_yAojv2hquHBGsyY',
].join(' ');

/**
 * Kept alive across a crash that is not ours.
 *
 * `wrangler dev` puts a ProxyWorker in front of the Worker, and when a client
 * connection is severed rather than closed — a game socket going down with the
 * browser context that owned it, an asset fetch abandoned mid-flight — that
 * proxy raises `Network connection lost.`, which the ProxyController treats as
 * fatal. Wrangler then prints an `✘ [ERROR]` with no message and exits, and
 * every test after that fails on `ERR_CONNECTION_REFUSED` having never reached
 * the app. Reproduced locally: seven tests pass, the relay dies, the remaining
 * twenty fail on navigation. The detail is in `~/.config/.wrangler/logs`, which
 * CI uploads with the report; the blank `✘ [ERROR]` is all that reaches stdout,
 * which is why this looked for a long time like a memory problem.
 *
 * There is no flag to turn that proxy off, and closing sockets more politely in
 * the app would not help: `context.close()` kills the browser outright, so no
 * unload handler runs. Changing how the app behaves in production to avoid a
 * bug in a development server would be the wrong repair anyway.
 *
 * So the relay is supervised. When it dies it is back in about a second, and
 * the damage is bounded to whichever test was mid-request rather than the whole
 * remainder of the shard. That one test is what `retries` is for, below.
 */
const supervised = `while :; do ${relay}; echo "relay exited — restarting"; sleep 1; done`;

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

  /**
   * One retry in CI, for the relay crash above and nothing else.
   *
   * A retry is a poor instrument — it hides real flakes as readily as borrowed
   * ones — so it is deliberately one, and deliberately not enabled locally,
   * where a failure should be looked at rather than rolled again. If a test
   * starts needing the retry regularly, that is a finding about the test and
   * not a cost of doing business.
   */
  retries: process.env.CI ? 1 : 0,

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: undefined } }],

  webServer: {
    command: supervised,
    cwd: '../worker',
    url: `http://localhost:${PORT}/api/health`,
    // Locally, a relay already running is a convenience. In CI there is never
    // one to reuse, and a half-dead process answering the health check is
    // exactly what this file exists to prevent.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
