/**
 * The game room Durable Object: transport and offline mailbox for one game.
 *
 * Addressed by `idFromName(gameId)`, so the same game always resolves to the
 * same instance even after its storage has been wiped. **It is never
 * authoritative.** Both clients hold the full log; this copy exists so that a
 * move made while the opponent is offline has somewhere to wait. A client that
 * disagrees with this object believes itself.
 *
 * What it can do: store opaque entries in order, hand back the suffix a peer is
 * missing, send a content-free push, and evict old games behind a tombstone.
 * What it cannot do: read a move, verify a signature, or decide who won.
 */
import { DurableObject } from 'cloudflare:workers';

import {
  ErrorCode,
  MAX_ENTRY_BYTES,
  PROTOCOL_VERSION,
  RETENTION_MS,
  TURN_REMINDER_MS,
  bytesEqual,
  clientMessageSchema,
  entryHash,
  entryPrevHash,
  entrySeq,
  fromBase64Url,
  isGenesisPrevHash,
  toBase64Url,
} from '@tabla/shared';
import type {
  ClientMessage,
  PushSubscriptionJson,
  ServerMessage,
  Tombstone,
} from '@tabla/shared';

import type { Env } from './env.ts';
import { sendPush } from './push.ts';
import type { PushOutcome } from './push.ts';

/** What the relay knows about a game's history. `tipSeq: -1` means nothing. */
export interface RoomState {
  tipSeq: number;
  tipHash: string | null;
  tombstone: Tombstone | null;
}

export interface AppendResult {
  ok: boolean;
  tipSeq: number;
  tipHash: string | null;
  code?: string;
  detail?: string;
}

/** A type alias, not an interface: `sql.exec<T>` requires an index signature. */
type MetaRow = { v: string };

/**
 * Per-connection state, kept in `serializeAttachment` so it survives
 * hibernation. Capped at 2 KiB by the runtime, hence only what SQLite cannot
 * give back: which game this socket is for, and who is on the other end.
 */
interface SocketAttachment {
  gameId: string;
  keyHash: string | null;
  proto: number;
}

export class GameRoomDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS log (
          seq   INTEGER PRIMARY KEY,
          entry BLOB NOT NULL,
          hash  BLOB NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS participant (
          key_hash  TEXT PRIMARY KEY,
          push_sub  TEXT,
          last_seen INTEGER NOT NULL
        )
      `);
      // Never deleted. This is what makes eviction safe.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS tombstone (
          game_id                TEXT PRIMARY KEY,
          tip_hash               BLOB NOT NULL,
          participant_key_hashes TEXT NOT NULL,
          ts                     INTEGER NOT NULL
        )
      `);
    });
  }

  // -- meta -----------------------------------------------------------------

  private meta(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec<MetaRow>(`SELECT v FROM meta WHERE k = ?`, key)
      .toArray()[0];
    return row?.v ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      key,
      value,
    );
  }

  private metaNumber(key: string): number | null {
    const raw = this.meta(key);
    return raw === null ? null : Number(raw);
  }

  /** Binds this instance to its game id the first time anyone touches it. */
  private ensureGameId(gameId: string): void {
    if (this.meta('gameId') === null) this.setMeta('gameId', gameId);
  }

  // -- reads ----------------------------------------------------------------

  private tipRow(): { seq: number; hash: ArrayBuffer } | undefined {
    return this.ctx.storage.sql
      .exec<{ seq: number; hash: ArrayBuffer }>(
        `SELECT seq, hash FROM log ORDER BY seq DESC LIMIT 1`,
      )
      .toArray()[0];
  }

  async state(): Promise<RoomState> {
    const tip = this.tipRow();
    return {
      tipSeq: tip ? tip.seq : -1,
      tipHash: tip ? toBase64Url(new Uint8Array(tip.hash)) : null,
      tombstone: this.tombstone(),
    };
  }

  private tombstone(): Tombstone | null {
    const row = this.ctx.storage.sql
      .exec<{
        game_id: string;
        tip_hash: ArrayBuffer;
        participant_key_hashes: string;
        ts: number;
      }>(`SELECT * FROM tombstone LIMIT 1`)
      .toArray()[0];

    if (!row) return null;

    return {
      gameId: row.game_id,
      tipHash: toBase64Url(new Uint8Array(row.tip_hash)),
      participantKeyHashes: JSON.parse(row.participant_key_hashes),
      timestamp: row.ts,
    };
  }

  /** Encoded entries from `fromSeq` onward, for a peer that is behind. */
  async entriesFrom(fromSeq: number): Promise<{ seq: number; entry: string }[]> {
    return this.ctx.storage.sql
      .exec<{ seq: number; entry: ArrayBuffer }>(
        `SELECT seq, entry FROM log WHERE seq >= ? ORDER BY seq`,
        fromSeq,
      )
      .toArray()
      .map((row) => ({ seq: row.seq, entry: toBase64Url(new Uint8Array(row.entry)) }));
  }

  // -- appends --------------------------------------------------------------

  /**
   * Stores entries that continue the log this object already holds.
   *
   * The checks here are transport-level only: size, contiguity, and that each
   * entry's `prevHash` matches the hash of what precedes it. That is enough to
   * stop a racing or buggy client from corrupting the shared copy, and it is
   * all the relay is capable of — it cannot verify a signature or a move.
   *
   * Entries are applied all-or-nothing so a partial batch never lands.
   */
  async append(gameId: string, keyHash: string, entries: Uint8Array[], now: number)
  : Promise<AppendResult> {
    this.ensureGameId(gameId);

    const tip = this.tipRow();
    let expectedSeq = tip ? tip.seq + 1 : 0;
    let expectedPrev: Uint8Array | null = tip ? new Uint8Array(tip.hash) : null;

    const staged: { seq: number; entry: Uint8Array; hash: Uint8Array }[] = [];

    for (const entry of entries) {
      if (entry.length > MAX_ENTRY_BYTES) {
        return this.reject(ErrorCode.EntryTooLarge, `entry exceeds ${MAX_ENTRY_BYTES} bytes`);
      }

      let seq: number;
      let prev: Uint8Array;
      try {
        seq = entrySeq(entry);
        prev = entryPrevHash(entry);
      } catch (error) {
        return this.reject(ErrorCode.BadMessage, String(error));
      }

      if (seq !== expectedSeq) {
        // Re-sending an entry we already hold is normal after a reconnect, not
        // an error — but only if it is byte-identical to what we stored.
        if (seq < expectedSeq) {
          const held = this.entryAt(seq);
          if (held && bytesEqual(held, entry)) continue;
          return this.reject(ErrorCode.ChainMismatch, `entry ${seq} differs from the stored copy`);
        }
        return this.reject(ErrorCode.SeqGap, `expected sequence ${expectedSeq}, got ${seq}`);
      }

      const chainsCorrectly =
        expectedPrev === null ? isGenesisPrevHash(prev) : bytesEqual(prev, expectedPrev);
      if (!chainsCorrectly) {
        return this.reject(ErrorCode.ChainMismatch, `entry ${seq} does not continue the log`);
      }

      const hash = await entryHash(entry);
      staged.push({ seq, entry, hash });
      expectedSeq = seq + 1;
      expectedPrev = hash;
    }

    for (const row of staged) {
      this.ctx.storage.sql.exec(
        `INSERT INTO log (seq, entry, hash) VALUES (?, ?, ?)`,
        row.seq,
        bufferOf(row.entry),
        bufferOf(row.hash),
      );
    }

    if (staged.length > 0) {
      this.touch(keyHash, now);
      await this.scheduleTurnReminder(now, keyHash);
      await this.notifyOpponent(keyHash);
    }

    const state = await this.state();
    return { ok: true, tipSeq: state.tipSeq, tipHash: state.tipHash };
  }

  private entryAt(seq: number): Uint8Array | null {
    const row = this.ctx.storage.sql
      .exec<{ entry: ArrayBuffer }>(`SELECT entry FROM log WHERE seq = ?`, seq)
      .toArray()[0];
    return row ? new Uint8Array(row.entry) : null;
  }

  // -- live sessions --------------------------------------------------------

  /**
   * Accepts a WebSocket using the Hibernation API.
   *
   * `acceptWebSocket` rather than `ws.accept()` is what lets an idle game cost
   * nothing: the object can be evicted from memory while the connection stays
   * open, and is only revived when a message actually arrives. That matters
   * here more than in most applications, because a correspondence game is idle
   * essentially all of the time.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const gameId = new URL(request.url).searchParams.get('gameId');
    if (!gameId) return new Response('missing gameId', { status: 400 });

    const pair = new WebSocketPair();
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    // Per-connection state has a 2 KiB budget, so it holds only what cannot be
    // recovered from SQLite when the object wakes up.
    server.serializeAttachment({ gameId, keyHash: null, proto: PROTOCOL_VERSION });

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private attachmentOf(ws: WebSocket): SocketAttachment {
    return (ws.deserializeAttachment() ?? {
      gameId: '',
      keyHash: null,
      proto: PROTOCOL_VERSION,
    }) as SocketAttachment;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return this.fail(ws, ErrorCode.BadMessage, 'expected text');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.fail(ws, ErrorCode.BadMessage, 'not valid JSON');
    }

    const message = clientMessageSchema.safeParse(parsed);
    if (!message.success) return this.fail(ws, ErrorCode.BadMessage, message.error.message);

    const attachment = this.attachmentOf(ws);
    const now = Date.now();

    switch (message.data.t) {
      case 'hello':
        return this.onHello(ws, attachment, message.data, now);
      case 'append':
        return this.onAppend(ws, attachment, message.data, now);
      case 'req':
        return this.onReq(ws, message.data.fromSeq);
      case 'push_sub':
        if (!attachment.keyHash) return this.fail(ws, ErrorCode.BadMessage, 'say hello first');
        await this.setPushSubscription(attachment.keyHash, message.data.subscription, now);
        return;
    }
  }

  private async onHello(
    ws: WebSocket,
    attachment: SocketAttachment,
    hello: Extract<ClientMessage, { t: 'hello' }>,
    now: number,
  ): Promise<void> {
    if (hello.v !== PROTOCOL_VERSION) {
      return this.fail(ws, ErrorCode.ProtocolVersion, `relay speaks v${PROTOCOL_VERSION}`);
    }

    ws.serializeAttachment({ ...attachment, keyHash: hello.keyHash });
    this.touch(hello.keyHash, now);

    // The client compares this against its own tip and decides what to do:
    // ask for what it is missing, upload what the relay is missing, or, if the
    // relay holds nothing, re-upload everything after checking the tombstone.
    const state = await this.state();
    this.send(ws, {
      t: 'state',
      tipSeq: state.tipSeq,
      tipHash: state.tipHash,
      tombstone: state.tombstone,
    });
  }

  private async onAppend(
    ws: WebSocket,
    attachment: SocketAttachment,
    append: Extract<ClientMessage, { t: 'append' }>,
    now: number,
  ): Promise<void> {
    if (!attachment.keyHash) return this.fail(ws, ErrorCode.BadMessage, 'say hello first');

    const entries = append.entries.map((e) => fromBase64Url(e.entry));
    const result = await this.append(attachment.gameId, attachment.keyHash, entries, now);

    if (!result.ok) {
      return this.fail(ws, result.code ?? ErrorCode.BadMessage, result.detail ?? '');
    }

    this.send(ws, { t: 'appended', tipSeq: result.tipSeq, tipHash: result.tipHash! });

    // Hand the new entries straight to the opponent if they are here, so a live
    // game does not need a round trip to notice a move.
    const fanout = append.entries;
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const theirs = this.attachmentOf(other);
      if (theirs.keyHash === attachment.keyHash) continue;
      this.send(other, { t: 'entries', fromSeq: fanout[0]?.seq ?? 0, entries: fanout });
    }
  }

  private async onReq(ws: WebSocket, fromSeq: number): Promise<void> {
    const entries = await this.entriesFrom(fromSeq);
    this.send(ws, { t: 'entries', fromSeq, entries });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1006 is never a legal close code to send back.
    ws.close(code === 1006 ? 1000 : code, reason);
  }

  async webSocketError(): Promise<void> {
    // Nothing to clean up: all durable state is in SQLite, not in the socket.
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  private fail(ws: WebSocket, code: string, detail: string): void {
    this.send(ws, { t: 'err', code, detail });
  }

  /**
   * Tells the opponent it is their turn, without telling them anything else.
   *
   * Skipped entirely when the opponent already has a live socket: they have the
   * move already, and a notification would just be noise.
   */
  private async notifyOpponent(authorKeyHash: string): Promise<void> {
    if (this.hasLiveSocket((keyHash) => keyHash !== null && keyHash !== authorKeyHash)) return;
    await this.pushToOpponents(authorKeyHash);
  }

  /**
   * Counts delivery attempts and remembers the last result.
   *
   * A push that fails is invisible otherwise — the person simply never hears
   * about their turn — so it is worth a few bytes to be able to tell.
   */
  private recordPushAttempt(outcome: PushOutcome): void {
    this.setMeta('pushCount', String(Number(this.meta('pushCount') ?? '0') + 1));
    this.setMeta('lastPushOk', outcome.ok ? '1' : '0');
  }

  private hasLiveSocket(match: (keyHash: string | null) => boolean): boolean {
    return this.ctx
      .getWebSockets()
      .some((socket) => match(this.attachmentOf(socket).keyHash));
  }

  /** The single reminder sent when a turn has gone unanswered for a day. */
  private async onTurnReminder(): Promise<void> {
    const lastAuthor = this.meta('lastAuthor');
    if (lastAuthor) await this.pushToOpponents(lastAuthor);
  }

  private async pushToOpponents(authorKeyHash: string): Promise<void> {
    const gameId = this.meta('gameId');
    if (!gameId) return;

    for (const subscription of this.opponentSubscriptions(authorKeyHash)) {
      const outcome = await sendPush(this.env, subscription, { gameId });
      this.recordPushAttempt(outcome);

      // A dead endpoint is dropped rather than retried forever.
      if (outcome.expired) {
        this.ctx.storage.sql.exec(
          `UPDATE participant SET push_sub = NULL WHERE push_sub = ?`,
          JSON.stringify(subscription),
        );
      }
    }
  }

  private async reject(code: string, detail: string): Promise<AppendResult> {
    const state = await this.state();
    return { ok: false, tipSeq: state.tipSeq, tipHash: state.tipHash, code, detail };
  }

  // -- participants ---------------------------------------------------------

  /** Records that a participant was here, without learning anything about them. */
  private touch(keyHash: string, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO participant (key_hash, last_seen) VALUES (?, ?)
         ON CONFLICT(key_hash) DO UPDATE SET last_seen = excluded.last_seen`,
      keyHash,
      now,
    );
  }

  async setPushSubscription(
    keyHash: string,
    subscription: PushSubscriptionJson | null,
    now: number,
  ): Promise<void> {
    this.touch(keyHash, now);
    this.ctx.storage.sql.exec(
      `UPDATE participant SET push_sub = ? WHERE key_hash = ?`,
      subscription === null ? null : JSON.stringify(subscription),
      keyHash,
    );
  }

  /** Everyone in this game other than `keyHash` who has a push subscription. */
  private opponentSubscriptions(keyHash: string): PushSubscriptionJson[] {
    return this.ctx.storage.sql
      .exec<{ push_sub: string | null }>(
        `SELECT push_sub FROM participant WHERE key_hash != ? AND push_sub IS NOT NULL`,
        keyHash,
      )
      .toArray()
      .map((row) => JSON.parse(row.push_sub!) as PushSubscriptionJson);
  }

  private participantKeyHashes(): string[] {
    return this.ctx.storage.sql
      .exec<{ key_hash: string }>(`SELECT key_hash FROM participant ORDER BY key_hash`)
      .toArray()
      .map((row) => row.key_hash);
  }

  // -- alarms ---------------------------------------------------------------

  /**
   * A Durable Object has exactly one alarm, and this room needs two schedules:
   * a turn reminder and retention. Both due times are kept in `meta` and the
   * alarm is always set to whichever comes first.
   */
  private async rearm(): Promise<void> {
    const due = [this.metaNumber('reminderAt'), this.metaNumber('retentionAt')].filter(
      (t): t is number => t !== null,
    );

    if (due.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...due));
  }

  private async scheduleTurnReminder(now: number, authorKeyHash?: string): Promise<void> {
    if (authorKeyHash) this.setMeta('lastAuthor', authorKeyHash);
    this.setMeta('reminderAt', String(now + TURN_REMINDER_MS));
    this.setMeta('retentionAt', String(now + RETENTION_MS));
    this.setMeta('lastActivity', String(now));
    await this.rearm();
  }

  async alarm(): Promise<void> {
    const now = Date.now();

    const retentionAt = this.metaNumber('retentionAt');
    if (retentionAt !== null && now >= retentionAt) {
      await this.evict(now);
      return;
    }

    const reminderAt = this.metaNumber('reminderAt');
    if (reminderAt !== null && now >= reminderAt) {
      // Consumed before sending, so a reminder is sent once and never nags.
      this.ctx.storage.sql.exec(`DELETE FROM meta WHERE k = 'reminderAt'`);
      await this.onTurnReminder();
    }

    await this.rearm();
  }

  /**
   * Deletes a dormant game's ciphertext, leaving a permanent tombstone.
   *
   * The tombstone records the tip hash this relay actually held, computed here
   * rather than taken from a client: a client that reported a hash for a history
   * that never existed could otherwise permanently block its opponent from
   * restoring the game.
   *
   * Note this deletes rows rather than calling `deleteAll()` — the tombstone has
   * to outlive everything else.
   */
  private async evict(now: number): Promise<void> {
    const tip = this.tipRow();
    const gameId = this.meta('gameId');

    if (tip && gameId) {
      this.ctx.storage.sql.exec(
        `INSERT INTO tombstone (game_id, tip_hash, participant_key_hashes, ts)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(game_id) DO UPDATE SET
             tip_hash = excluded.tip_hash,
             participant_key_hashes = excluded.participant_key_hashes,
             ts = excluded.ts`,
        gameId,
        tip.hash,
        JSON.stringify(this.participantKeyHashes()),
        now,
      );
    }

    this.ctx.storage.sql.exec(`DELETE FROM log`);
    this.ctx.storage.sql.exec(`DELETE FROM participant`);
    this.ctx.storage.sql.exec(`DELETE FROM meta WHERE k IN ('reminderAt', 'retentionAt')`);
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * Test-only: drops the stored ciphertext as though the instance had been
   * evicted, so the resume path can be exercised end to end. Gated behind an
   * environment flag that is never set in production.
   */
  async wipeForTest(): Promise<void> {
    if (this.env.TABLA_TEST_ENDPOINTS !== 'true') {
      throw new Error('test endpoints are disabled');
    }
    await this.evict(Date.now());
  }
}

/** SQLite BLOB bindings want a plain ArrayBuffer. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
