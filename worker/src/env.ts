/**
 * Bindings, built on the types `wrangler types` generates from wrangler.jsonc.
 *
 * Run `just types` after changing bindings. The generated file is not committed
 * — it is a build artifact of the config, and thousands of lines of runtime
 * type declarations besides.
 */

export interface Env extends Omit<Cloudflare.Env, 'TABLA_TEST_ENDPOINTS'> {
  /**
   * `"true"` enables the dev-only test endpoints. Widened from the literal type
   * wrangler infers from the default value, since tests override it.
   */
  TABLA_TEST_ENDPOINTS: string;

  /** Web Push credentials, set with `wrangler secret put`. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}
