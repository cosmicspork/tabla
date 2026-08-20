/**
 * Wire formats shared by the app, the Worker, and the tests.
 *
 * The relay is zero-knowledge: every field here is either routing metadata or
 * opaque ciphertext. Nothing in this file describes game state.
 */
import { z } from 'zod';

/** base64url without padding, as used for every binary field on the wire. */
const b64url = z.string().regex(/^[A-Za-z0-9_-]*$/, 'expected unpadded base64url');

export const gameIdSchema = b64url.length(22, 'gameId is 16 bytes in base64url');
export const blobIdSchema = b64url.length(22, 'blobId is 16 bytes in base64url');

/** A Web Push subscription as produced by PushManager.subscribe(). */
export const pushSubscriptionSchema = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export type PushSubscriptionJson = z.infer<typeof pushSubscriptionSchema>;

// ---------------------------------------------------------------------------
// Invite HTTP API
// ---------------------------------------------------------------------------

export const createInviteRequestSchema = z.object({
  /** Sealed invite config. The key lives only in the URL fragment. */
  blob: b64url.max(8192),
});
export const createInviteResponseSchema = z.object({
  blobId: blobIdSchema,
  expiresAt: z.number().int(),
  /**
   * Proof that this caller is the one who made the invite.
   *
   * The relay never sees the initiator's identity key — it is sealed inside the
   * blob — so it has no way to recognise them later. A bearer token handed back
   * at creation is the smallest thing that lets an invite be withdrawn without
   * the relay learning who anybody is.
   */
  cancelToken: b64url.length(22),
});

export const cancelInviteRequestSchema = z.object({
  cancelToken: b64url.length(22),
});

export const claimInviteRequestSchema = z.object({
  claimerPubKey: b64url.length(43),
  /** Ed25519 over "tabla-claim/v1" || blobId, verified by the initiator, not the relay. */
  sig: b64url.length(86),
});
export const claimInviteResponseSchema = z.object({ blob: b64url });

/** What the initiator polls for to learn who claimed its invite. */
export const inviteClaimStatusSchema = z.object({
  claimed: z.boolean(),
  claimerPubKey: b64url.length(43).optional(),
  sig: b64url.length(86).optional(),
});

// ---------------------------------------------------------------------------
// Game room WebSocket protocol
// ---------------------------------------------------------------------------

/** A log entry on the wire: canonical preimage || 64-byte signature, base64url. */
export const wireEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  entry: b64url,
});
export type WireEntry = z.infer<typeof wireEntrySchema>;

export const tombstoneSchema = z.object({
  gameId: gameIdSchema,
  tipHash: b64url.length(43),
  participantKeyHashes: z.array(b64url.length(43)),
  timestamp: z.number().int(),
});
export type Tombstone = z.infer<typeof tombstoneSchema>;

/** Client to relay. */
export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    v: z.number().int(),
    keyHash: b64url.length(43),
    tipSeq: z.number().int(),
    tipHash: b64url.length(43).nullable(),
  }),
  z.object({ t: z.literal('append'), entries: z.array(wireEntrySchema).max(256) }),
  z.object({ t: z.literal('req'), fromSeq: z.number().int().nonnegative() }),
  z.object({ t: z.literal('push_sub'), subscription: pushSubscriptionSchema }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Relay to client. `tipSeq: -1` means the relay holds no log (evicted or fresh). */
export const serverMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('state'),
    tipSeq: z.number().int(),
    tipHash: b64url.length(43).nullable(),
    tombstone: tombstoneSchema.nullable().optional(),
  }),
  z.object({ t: z.literal('entries'), fromSeq: z.number().int(), entries: z.array(wireEntrySchema) }),
  z.object({ t: z.literal('appended'), tipSeq: z.number().int(), tipHash: b64url.length(43) }),
  /**
   * How many other participants hold a live socket on this room right now.
   *
   * This is liveness of an opaque key hash and nothing else — the relay has
   * always known it (it suppresses push for a connected opponent), and saying
   * so out loud reveals no more than the fan-out already does.
   */
  z.object({ t: z.literal('presence'), others: z.number().int().nonnegative() }),
  z.object({ t: z.literal('err'), code: z.string(), detail: z.string().optional() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Error codes the relay may return. All are transport-level. */
export const ErrorCode = {
  BadMessage: 'bad_message',
  ProtocolVersion: 'protocol_version',
  SeqGap: 'seq_gap',
  ChainMismatch: 'chain_mismatch',
  EntryTooLarge: 'entry_too_large',
  AlreadyClaimed: 'already_claimed',
  Expired: 'expired',
  NotFound: 'not_found',
  Forbidden: 'forbidden',
  MailboxFull: 'mailbox_full',
} as const;

// ---------------------------------------------------------------------------
// Pair mailboxes
// ---------------------------------------------------------------------------

/**
 * Where one player leaves an invitation for another.
 *
 * Opaque to the relay in the strongest sense available: it is derived from a
 * secret only the two of them can compute, so it cannot be linked to either
 * public key, and cannot be guessed or enumerated. See ARCHITECTURE,
 * "Inviting a contact".
 */
export const mailboxIdSchema = b64url.length(22, 'mailboxId is 16 bytes in base64url');
export const messageIdSchema = b64url.length(22, 'messageId is 16 bytes in base64url');

export const postMailboxRequestSchema = z.object({
  /** A sealed `MailboxInvite`. Small by construction; the cap is a backstop. */
  body: b64url.max(2048),
});
export const postMailboxResponseSchema = z.object({
  messageId: messageIdSchema,
  expiresAt: z.number().int(),
});

/**
 * Polling several mailboxes at once.
 *
 * One request rather than one per contact. It tells the relay how many
 * mailboxes this device holds, which N parallel requests from one address would
 * have told it anyway.
 */
export const pollMailboxRequestSchema = z.object({
  ids: z.array(mailboxIdSchema).min(1).max(64),
});
export const mailboxMessageSchema = z.object({
  messageId: messageIdSchema,
  body: b64url,
  createdAt: z.number().int(),
});
export const pollMailboxResponseSchema = z.object({
  mailboxes: z.record(mailboxIdSchema, z.array(mailboxMessageSchema)),
});

export const mailboxPushRequestSchema = z.object({
  subscription: pushSubscriptionSchema,
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/**
 * The entire push payload. Content-free by design: the client fetches and
 * decrypts real state on open. Never add game content here — APNs and FCM
 * relay this even though RFC 8291 encrypts it in transit.
 */
export const pushPayloadSchema = z.union([
  z.object({ gameId: gameIdSchema }),
  /** Something is waiting in a mailbox. Which mailbox is opaque to the relay. */
  z.object({ mailbox: mailboxIdSchema }),
]);
export type PushPayload = z.infer<typeof pushPayloadSchema>;
