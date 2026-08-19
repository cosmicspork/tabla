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
        // Enables the dev-only wipe endpoint the eviction tests use.
        bindings: { TABLA_TEST_ENDPOINTS: 'true' },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
