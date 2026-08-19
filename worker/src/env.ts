import type { GameRoomDO } from './game-room.ts';
import type { PendingInviteDO } from './pending-invite.ts';

export interface Env {
  ASSETS: Fetcher;
  GAME_ROOMS: DurableObjectNamespace<GameRoomDO>;
  INVITES: DurableObjectNamespace<PendingInviteDO>;

  /** "true" enables dev-only test endpoints. Never enabled in production. */
  TABLA_TEST_ENDPOINTS: string;

  /** Web Push VAPID credentials, set via `wrangler secret put`. */
  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}
