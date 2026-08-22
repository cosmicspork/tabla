/**
 * tabla relay.
 *
 * This Worker is deliberately incurious: it routes ciphertext between two
 * clients and stores it as an offline mailbox. It holds no key, verifies no
 * signature, and cannot read a move. Everything it does understand about an
 * entry is described in `@tabla/shared/framing`.
 */
import {
  BLOB_ID_LEN,
  cancelInviteRequestSchema,
  cancelLinkRequestSchema,
  createLinkRequestSchema,
  gamePushRequestSchema,
  mailboxPushRequestSchema,
  pollMailboxRequestSchema,
  postMailboxRequestSchema,
  ErrorCode,
  claimInviteRequestSchema,
  createInviteRequestSchema,
  fromBase64Url,
  toBase64Url,
} from '@tabla/shared';

import type { Env } from './env.ts';

export { DeviceLinkDO } from './device-link.ts';
export { GameRoomDO } from './game-room.ts';
export { MailboxDO } from './mailbox.ts';
export { PendingInviteDO } from './pending-invite.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
      try {
        return await route(request, env, url);
      } catch (error) {
        // Never leak internals; there is nothing here worth describing anyway.
        console.error('relay error', error);
        return json({ code: 'internal' }, 500);
      }
    }

    // Static assets. `run_worker_first` keeps this unreachable in production,
    // but it matters when the Worker is exercised directly under test.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === '/api/health') {
    return json({ ok: true });
  }

  // Clients need this to subscribe. It is public by design.
  if (path === '/api/vapid') {
    return json({ publicKey: env.VAPID_PUBLIC_KEY ?? null });
  }

  if (path === '/api/invite' && request.method === 'POST') {
    return createInvite(request, env);
  }

  const inviteMatch = path.match(/^\/api\/invite\/([A-Za-z0-9_-]{22})(\/claim|\/cancel)?$/);
  if (inviteMatch) {
    const [, blobId, subPath] = inviteMatch;
    if (subPath === '/claim' && request.method === 'POST') return claimInvite(request, env, blobId);
    if (subPath === '/cancel' && request.method === 'POST') {
      return cancelInvite(request, env, blobId);
    }
    if (!subPath && request.method === 'GET') return inviteStatus(env, blobId);
    return json({ code: 'method_not_allowed' }, 405);
  }

  if (path === '/api/link' && request.method === 'POST') {
    return createLink(request, env);
  }

  const linkMatch = path.match(/^\/api\/link\/([A-Za-z0-9_-]{22})(\/take|\/cancel)?$/);
  if (linkMatch) {
    const [, linkId, subPath] = linkMatch;
    if (subPath === '/take' && request.method === 'POST') return takeLink(env, linkId);
    if (subPath === '/cancel' && request.method === 'POST') return cancelLink(request, env, linkId);
    if (!subPath && request.method === 'GET') return linkStatus(env, linkId);
    return json({ code: 'method_not_allowed' }, 405);
  }

  // Before the id-shaped match below, or "poll" would be read as a mailbox id.
  if (path === '/api/mailbox/poll' && request.method === 'POST') {
    return pollMailboxes(request, env);
  }

  const mailboxMatch = path.match(
    /^\/api\/mailbox\/([A-Za-z0-9_-]{22})(?:\/(push|[A-Za-z0-9_-]{22}))?$/,
  );
  if (mailboxMatch) {
    const [, mailboxId, tail] = mailboxMatch;
    if (!tail && request.method === 'POST') return postMailbox(request, env, mailboxId);
    if (tail === 'push' && request.method === 'PUT') {
      return registerMailboxPush(request, env, mailboxId);
    }
    if (tail && tail !== 'push' && request.method === 'DELETE') {
      await mailboxFor(env, mailboxId).remove(tail);
      return json({ ok: true });
    }
    return json({ code: 'method_not_allowed' }, 405);
  }

  // Notifications are switched on in settings, for every game at once, and a
  // room used to be reachable only down its own WebSocket — so the games
  // already in progress went on hearing nothing. This is that door.
  const gamePushMatch = path.match(/^\/api\/game\/([A-Za-z0-9_-]{22})\/push$/);
  if (gamePushMatch) {
    if (request.method !== 'PUT') return json({ code: 'method_not_allowed' }, 405);
    return registerGamePush(request, env, gamePushMatch[1]);
  }

  const wsMatch = path.match(/^\/ws\/game\/([A-Za-z0-9_-]{22})$/);
  if (wsMatch) {
    const gameId = wsMatch[1];
    // The room is addressed by name, so the same game always reaches the same
    // instance — which is what makes resume work after its storage was wiped.
    const stub = roomFor(env, gameId);
    const url = new URL(request.url);
    url.searchParams.set('gameId', gameId);
    return stub.fetch(new Request(url, request));
  }

  if (env.TABLA_TEST_ENDPOINTS === 'true') {
    const wipe = path.match(/^\/api\/_test\/wipe\/([A-Za-z0-9_-]{22})$/);
    if (wipe && request.method === 'POST') {
      await roomFor(env, wipe[1]).wipeForTest();
      return json({ ok: true });
    }
  }

  return json({ code: ErrorCode.NotFound }, 404);
}

// -- invites ----------------------------------------------------------------

async function createInvite(request: Request, env: Env): Promise<Response> {
  const parsed = createInviteRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ code: ErrorCode.BadMessage }, 400);

  // The relay picks the blob id so a client cannot squat on or overwrite one.
  const blobId = toBase64Url(crypto.getRandomValues(new Uint8Array(BLOB_ID_LEN)));
  // Minted here rather than in the DO, beside the id it goes with, and returned
  // exactly once: `status` never repeats it, so only the caller ever holds it.
  const cancelToken = toBase64Url(crypto.getRandomValues(new Uint8Array(BLOB_ID_LEN)));
  const blob = fromBase64Url(parsed.data.blob);

  const stub = env.INVITES.get(env.INVITES.idFromName(blobId));
  const { expiresAt } = await stub.create(blobId, toArrayBuffer(blob), cancelToken, Date.now());

  return json({ blobId, expiresAt, cancelToken }, 201);
}

async function claimInvite(request: Request, env: Env, blobId: string): Promise<Response> {
  const parsed = claimInviteRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ code: ErrorCode.BadMessage }, 400);

  const stub = env.INVITES.get(env.INVITES.idFromName(blobId));
  const result = await stub.claim(parsed.data.claimerPubKey, parsed.data.sig, Date.now());

  if (!result.ok) {
    const status =
      result.code === ErrorCode.AlreadyClaimed ? 409 : result.code === ErrorCode.Expired ? 410 : 404;
    return json({ code: result.code }, status);
  }

  return json({ blob: result.blob });
}

/**
 * Withdraws an invite nobody took.
 *
 * Authorised by the token handed back at creation and nothing else — the relay
 * has never seen the initiator's key, so there is nothing else it could check.
 */
async function cancelInvite(request: Request, env: Env, blobId: string): Promise<Response> {
  const parsed = cancelInviteRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ code: ErrorCode.BadMessage }, 400);

  const stub = env.INVITES.get(env.INVITES.idFromName(blobId));
  const result = await stub.cancel(parsed.data.cancelToken);

  if (!result.ok) {
    const status =
      result.code === ErrorCode.AlreadyClaimed ? 409 : result.code === ErrorCode.Forbidden ? 403 : 404;
    return json({ code: result.code }, status);
  }

  return json({ ok: true });
}

async function inviteStatus(env: Env, blobId: string): Promise<Response> {
  const stub = env.INVITES.get(env.INVITES.idFromName(blobId));
  const status = await stub.status();

  if (!status.exists) return json({ code: ErrorCode.NotFound }, 404);

  return json({
    claimed: status.claimed,
    claimerPubKey: status.claimerPubKey,
    sig: status.sig,
  });
}

// -- device links -----------------------------------------------------------

/**
 * Offers this installation to another of the same person's devices.
 *
 * The caller names the link, because the name is derived from the words that
 * are also the passphrase — so the relay never learns anything that would let
 * it find or guess what it is holding. It still mints the cancel token, which
 * is the one secret here the client has no way to derive.
 */
async function createLink(request: Request, env: Env): Promise<Response> {
  const parsed = createLinkRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ code: ErrorCode.BadMessage }, 400);

  const cancelToken = toBase64Url(crypto.getRandomValues(new Uint8Array(BLOB_ID_LEN)));
  const blob = fromBase64Url(parsed.data.blob);

  const stub = linkFor(env, parsed.data.linkId);
  const result = await stub.create(
    parsed.data.linkId,
    toArrayBuffer(blob),
    cancelToken,
    Date.now(),
  );

  if (!result.ok) return json({ code: result.code }, 409);

  return json({ expiresAt: result.expiresAt, cancelToken }, 201);
}

async function takeLink(env: Env, linkId: string): Promise<Response> {
  const result = await linkFor(env, linkId).take(Date.now());

  if (!result.ok) {
    const status =
      result.code === ErrorCode.AlreadyClaimed ? 409 : result.code === ErrorCode.Expired ? 410 : 404;
    return json({ code: result.code }, status);
  }

  return json({ blob: result.blob });
}

async function cancelLink(request: Request, env: Env, linkId: string): Promise<Response> {
  const parsed = cancelLinkRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ code: ErrorCode.BadMessage }, 400);

  const result = await linkFor(env, linkId).cancel(parsed.data.cancelToken);

  if (!result.ok) {
    return json({ code: result.code }, result.code === ErrorCode.Forbidden ? 403 : 404);
  }

  return json({ ok: true });
}

async function linkStatus(env: Env, linkId: string): Promise<Response> {
  const status = await linkFor(env, linkId).status(Date.now());
  if (!status.exists) return json({ code: ErrorCode.NotFound }, 404);

  return json({ taken: status.taken, expiresAt: status.expiresAt });
}

function linkFor(env: Env, linkId: string) {
  return env.LINKS.get(env.LINKS.idFromName(linkId));
}

// -- mailboxes --------------------------------------------------------------

/**
 * Leaves a sealed invitation in a mailbox.
 *
 * Unauthenticated, and deliberately so: the mailbox id is a capability derived
 * from a secret only the two people involved can compute, so anyone able to
 * name one is already entitled to write to it. See ARCHITECTURE.
 */
async function postMailbox(request: Request, env: Env, mailboxId: string): Promise<Response> {
  const parsed = postMailboxRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ code: ErrorCode.BadMessage }, 400);

  const stub = mailboxFor(env, mailboxId);
  await stub.remember(mailboxId);
  const result = await stub.post(parsed.data.body, Date.now());

  if (!result.ok) return json({ code: result.code }, 429);

  return json({ messageId: result.messageId, expiresAt: result.expiresAt }, 201);
}

/**
 * Reads several mailboxes at once.
 *
 * One request rather than one per contact — which tells the relay how many
 * mailboxes this device holds, and nothing it would not have learned from the
 * same number of separate requests.
 */
async function pollMailboxes(request: Request, env: Env): Promise<Response> {
  const parsed = pollMailboxRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ code: ErrorCode.BadMessage }, 400);

  const now = Date.now();
  const mailboxes: Record<string, unknown[]> = {};

  await Promise.all(
    parsed.data.ids.map(async (id) => {
      mailboxes[id] = await mailboxFor(env, id).list(now);
    }),
  );

  return json({ mailboxes });
}

async function registerMailboxPush(
  request: Request,
  env: Env,
  mailboxId: string,
): Promise<Response> {
  const parsed = mailboxPushRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ code: ErrorCode.BadMessage }, 400);

  const stub = mailboxFor(env, mailboxId);
  await stub.remember(mailboxId);
  await stub.setPush(parsed.data.subscription);

  return json({ ok: true });
}

/**
 * Registers, or retires, one device's push subscription for one game.
 *
 * The caller asserts its own key hash, which proves nothing — but `hello` on
 * the socket proves nothing either, and never has: the relay has never held a
 * key it could check one against. Anyone who knows a game id can already reach
 * its room, and what this adds to that is the ability to be told, in a payload
 * that says only "something happened", about a game they already knew of.
 */
async function registerGamePush(request: Request, env: Env, gameId: string): Promise<Response> {
  const parsed = gamePushRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ code: ErrorCode.BadMessage }, 400);

  const { keyHash, subscription, endpoint } = parsed.data;
  await roomFor(env, gameId).setPushSubscription(keyHash, subscription, Date.now(), endpoint);

  return json({ ok: true });
}

function mailboxFor(env: Env, mailboxId: string) {
  return env.MAILBOXES.get(env.MAILBOXES.idFromName(mailboxId));
}

// -- helpers ----------------------------------------------------------------

/** Room instances are addressed by name, so a game always finds its own room. */
export function roomFor(env: Env, gameId: string) {
  return env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(gameId));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
