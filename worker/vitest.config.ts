import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Storage is isolated per test *file*, so state accumulates within a file and
 * never leaks between them. The sync tests rely on that: they drive real
 * WebSocket connections against a Durable Object across several steps, which
 * needs the room to persist from one assertion to the next.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Enables the dev-only wipe endpoint the eviction tests use.
          TABLA_TEST_ENDPOINTS: 'true',
          // A throwaway VAPID pair so the push path actually runs. These are
          // test fixtures, generated for this file and used nowhere else.
          VAPID_SUBJECT: 'mailto:tests@tabla.invalid',
          VAPID_PUBLIC_KEY:
            'BIDXmumdfsiZPy2txPb8QGYvBw3NhTT007jCFFtnMjbIzl70LyaemszVUkk0Li5v8KocHDEQET9jXOLaiWPdRdU',
          VAPID_PRIVATE_KEY: 'qnDPmxTwbcx22FeqwG-ygCWHLje_yAojv2hquHBGsyY',
        },
        // Intercepts everything the Worker sends outward, so tests never touch
        // a real push service and delivery is deterministic.
        outboundService: (request: Request) =>
          new Response(null, { status: 201, headers: { 'x-intercepted': request.url } }),
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
