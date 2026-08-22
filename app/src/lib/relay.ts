/** HTTP calls to the relay. Everything here carries ciphertext or routing data. */
import {
  claimInviteResponseSchema,
  createInviteResponseSchema,
  createLinkResponseSchema,
  inviteClaimStatusSchema,
  linkStatusSchema,
  takeLinkResponseSchema,
  pollMailboxResponseSchema,
  postMailboxResponseSchema,
  type PushSubscriptionJson,
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

async function send(method: string, path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const post = (path: string, body: unknown) => send('POST', path, body);
const put = (path: string, body: unknown) => send('PUT', path, body);

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

// -- device links -----------------------------------------------------------

/**
 * Leaves this installation for another of the same person's devices.
 *
 * Unlike an invite, the caller names it: the id is derived from the words that
 * are also the passphrase, so the relay cannot enumerate what it holds. A name
 * already in use is refused rather than overwritten.
 */
export async function createLink(
  linkId: string,
  blob: string,
): Promise<{ expiresAt: number; cancelToken: string }> {
  return createLinkResponseSchema.parse(await unwrap(await post('/api/link', { linkId, blob })));
}

/** Collects the bundle. Works once, and the relay forgets it immediately. */
export async function takeLink(linkId: string): Promise<string> {
  const payload = await unwrap(await post(`/api/link/${linkId}/take`, {}));
  return takeLinkResponseSchema.parse(payload).blob;
}

/** What the offering device polls, to know when to stop showing the words. */
export async function linkStatus(linkId: string) {
  return linkStatusSchema.parse(await unwrap(await fetch(`/api/link/${linkId}`)));
}

export async function cancelLink(linkId: string, cancelToken: string): Promise<void> {
  await unwrap(await post(`/api/link/${linkId}/cancel`, { cancelToken }));
}

/**
 * Registers, or retires, this device's push subscription for one game, without
 * opening that game's board.
 *
 * Notifications are switched on once, in settings, for every game at once — and
 * until this existed the only way to tell a room was its WebSocket, so the games
 * already in progress carried on saying nothing until each was opened again.
 *
 * `keyHash` is asserted rather than proved, exactly as it is in `hello`: the
 * relay has never held a key it could check one against.
 */
export async function registerGamePush(
  gameId: string,
  keyHash: string,
  subscription: PushSubscriptionJson | null,
  endpoint?: string,
): Promise<void> {
  await unwrap(await put(`/api/game/${gameId}/push`, { keyHash, subscription, endpoint }));
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

// -- pair mailboxes ---------------------------------------------------------

/**
 * Leaves a sealed invitation where a contact will look for it.
 *
 * No credential beyond the address: it is derived from a secret only the two of
 * them can compute, so being able to name it is the authorisation. See
 * ARCHITECTURE, "Inviting a contact".
 */
export async function postMailbox(
  mailboxId: string,
  body: string,
): Promise<{ messageId: string; expiresAt: number }> {
  return postMailboxResponseSchema.parse(
    await unwrap(await post(`/api/mailbox/${mailboxId}`, { body })),
  );
}

/** Reads every mailbox this device holds, in one request. */
export async function pollMailboxes(
  ids: string[],
): Promise<Record<string, { messageId: string; body: string; createdAt: number }[]>> {
  const parsed = pollMailboxResponseSchema.parse(
    await unwrap(await post('/api/mailbox/poll', { ids })),
  );
  return parsed.mailboxes as Record<
    string,
    { messageId: string; body: string; createdAt: number }[]
  >;
}

/** Drops a message, once it is safely on this device. */
export async function deleteMailboxMessage(mailboxId: string, messageId: string): Promise<void> {
  await unwrap(await fetch(`/api/mailbox/${mailboxId}/${messageId}`, { method: 'DELETE' }));
}

/** Asks to be nudged when something arrives in one mailbox. */
export async function registerMailboxPush(
  mailboxId: string,
  subscription: PushSubscriptionJson,
): Promise<void> {
  await unwrap(
    await fetch(`/api/mailbox/${mailboxId}/push`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription }),
    }),
  );
}
