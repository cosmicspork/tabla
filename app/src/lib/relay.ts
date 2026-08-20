/** HTTP calls to the relay. Everything here carries ciphertext or routing data. */
import {
  claimInviteResponseSchema,
  createInviteResponseSchema,
  inviteClaimStatusSchema,
} from '@tabla/shared';
import type { SocketLike } from './sync/engine.ts';

export class RelayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`relay refused: ${code}`);
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function unwrap(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = (payload as { code?: string }).code ?? 'unknown';
    throw new RelayError(code, response.status);
  }
  return payload;
}

/** Uploads a sealed invite. The relay assigns the id, so it cannot be squatted. */
export async function createInvite(
  blob: string,
): Promise<{ blobId: string; expiresAt: number; cancelToken: string }> {
  return createInviteResponseSchema.parse(await unwrap(await post('/api/invite', { blob })));
}

/**
 * Withdraws an invite nobody has redeemed.
 *
 * Refused once it has been claimed: at that point there is a game, and a game
 * ends by being resigned rather than by having its invite taken away.
 */
export async function cancelInvite(blobId: string, cancelToken: string): Promise<void> {
  await unwrap(await post(`/api/invite/${blobId}/cancel`, { cancelToken }));
}

/**
 * Redeems an invite link.
 *
 * This is the single-use step: whoever calls it first binds their identity to
 * the game, and every later attempt is refused.
 */
export async function claimInvite(
  blobId: string,
  claimerPubKey: string,
  sig: string,
): Promise<string> {
  const payload = await unwrap(await post(`/api/invite/${blobId}/claim`, { claimerPubKey, sig }));
  return claimInviteResponseSchema.parse(payload).blob;
}

/** What the initiator polls to learn who took its link. */
export async function inviteStatus(blobId: string) {
  return inviteClaimStatusSchema.parse(await unwrap(await fetch(`/api/invite/${blobId}`)));
}

/** Opens the game socket. Same origin as the app, so no CORS and no cookies. */
export function openGameSocket(gameId: string): Promise<SocketLike> {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws/game/${gameId}`);

  return new Promise((resolve, reject) => {
    const onOpen = () => {
      socket.removeEventListener('error', onError);
      resolve(socket as unknown as SocketLike);
    };
    const onError = () => {
      socket.removeEventListener('open', onOpen);
      reject(new Error('could not reach the relay'));
    };

    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}
