/**
 * tabla relay.
 *
 * This Worker is deliberately incurious: it routes ciphertext between two
 * clients and stores it as an offline mailbox. It never holds a key, never
 * verifies a signature, and cannot read a move. All validation is client-side.
 */
import type { Env } from './env.ts';

export { GameRoomDO } from './game-room.ts';
export { PendingInviteDO } from './pending-invite.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
      return route(request, env, url);
    }

    // Static assets are served by the assets binding; run_worker_first keeps
    // this branch unreachable in production, but it matters under `vitest`.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  // Filled in across milestones 6 and 7.
  return new Response('not found', { status: 404 });
}
