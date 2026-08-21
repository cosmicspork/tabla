/**
 * The client half of the sync protocol.
 *
 * Deliberately headless and transport-agnostic: the same engine drives the UI
 * in a browser and two simulated clients inside the Worker test runtime. It owns
 * no storage and no timers, so its behaviour is entirely determined by the
 * messages it is given.
 *
 * **There is no separate outbox.** A move made offline is simply appended to the
 * local log, and everything past the relay's tip is what needs sending. The log
 * is the queue, which removes a whole class of bugs where the two disagree.
 */
import {
  MAX_APPEND_ENTRIES,
  PROTOCOL_VERSION,
  clientMessageSchema,
  fromBase64Url,
  serverMessageSchema,
  toBase64Url,
} from '@tabla/shared';
import type { ClientMessage, PushSubscriptionJson, ServerMessage, Tombstone } from '@tabla/shared';

import type { CoreModule, Identity, Log } from '../wasm/core.ts';

/** The bits of a WebSocket this engine uses, so tests can supply their own. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', listener: (event: unknown) => void): void;
}

export type Transport = (gameId: string) => Promise<SocketLike>;

export type SyncStatus =
  'idle' | 'connecting' | 'syncing' | 'synced' | 'offline' | 'diverged' | 'refused';

export interface SyncEvents {
  /** New verified entries landed. The UI should re-render. */
  onEntries?: (log: Log) => void;
  onStatus?: (status: SyncStatus, detail?: string) => void;
  /** The opponent connected or disconnected. */
  onPresence?: (present: boolean) => void;
  /** The relay rejected something, or offered a history we refuse. */
  onError?: (code: string, detail?: string) => void;
  /**
   * Another of this player's own devices claims the next move, until `until`.
   * A null body withdraws the claim.
   */
  onHold?: (body: Uint8Array | null, until: number) => void;
  /**
   * Entries we wrote were taken back, because another of this player's devices
   * got there first. The caller has to forget them from storage too.
   */
  onRolledBack?: (from: number, count: number) => void;
}

export interface SyncEngineOptions extends SyncEvents {
  core: CoreModule;
  /** base64url game id, matching the room the relay addresses by name. */
  gameId: string;
  /** SHA-256 of our own identity public key. */
  keyHash: Uint8Array;
  /** The local log. The engine appends to it and never replaces it. */
  log: Log;
  transport: Transport;
}

export class SyncEngine {
  private readonly core: CoreModule;
  private readonly gameId: string;
  private readonly keyHash: string;
  private readonly transport: Transport;
  private readonly events: SyncEvents;

  private socket: SocketLike | null = null;
  private log: Log;
  private statusValue: SyncStatus = 'idle';
  private opponentPresentValue = false;

  /** Highest sequence the relay has confirmed holding. -1 means none. */
  private relayTipSeq = -1;

  constructor(options: SyncEngineOptions) {
    this.core = options.core;
    this.gameId = options.gameId;
    this.keyHash = toBase64Url(options.keyHash);
    this.log = options.log;
    this.transport = options.transport;
    this.events = options;
  }

  get status(): SyncStatus {
    return this.statusValue;
  }

  get tipSeq(): number {
    return Number(this.log.tipSeq);
  }

  /** Entries the relay has not confirmed. Non-empty means work is pending. */
  get pendingCount(): number {
    return Math.max(0, this.tipSeq - this.relayTipSeq);
  }

  /** Whether the opponent has a live socket on this game. */
  get opponentPresent(): boolean {
    return this.opponentPresentValue;
  }

  private setPresence(present: boolean): void {
    if (present === this.opponentPresentValue) return;
    this.opponentPresentValue = present;
    this.events.onPresence?.(present);
  }

  private setStatus(status: SyncStatus, detail?: string): void {
    this.statusValue = status;
    this.events.onStatus?.(status, detail);
  }

  // -- connection -----------------------------------------------------------

  async connect(): Promise<void> {
    this.setStatus('connecting');

    const socket = await this.transport(this.gameId);
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      void this.receive(String((event as { data: unknown }).data));
    });
    socket.addEventListener('close', () => {
      this.socket = null;
      // Our own socket is gone, so we no longer know anything about theirs.
      this.setPresence(false);
      // Offline is a normal state for a correspondence game, not a failure.
      if (this.statusValue !== 'diverged' && this.statusValue !== 'refused') {
        this.setStatus('offline');
      }
    });
    socket.addEventListener('error', () => {
      this.setStatus('offline');
    });

    this.setStatus('syncing');
    this.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      keyHash: this.keyHash,
      tipSeq: this.tipSeq,
      tipHash: this.tipHashB64(),
    });
  }

  disconnect(): void {
    this.socket?.close(1000, 'client closing');
    this.socket = null;
    this.setPresence(false);
    this.setStatus('idle');
  }

  private tipHashB64(): string | null {
    const hash = this.log.tipHash;
    return hash ? toBase64Url(hash) : null;
  }

  private send(message: ClientMessage): void {
    if (!this.socket) return;
    // Validate on the way out too: a malformed message from us would be a bug
    // that is far easier to find here than at the other end.
    this.socket.send(JSON.stringify(clientMessageSchema.parse(message)));
  }

  // -- appending ------------------------------------------------------------

  /**
   * Signs a payload into the local log and sends it if we are connected.
   *
   * The move is committed locally whether or not the relay is reachable; that
   * is what makes a move made on a plane still a move.
   */
  appendLocal(identity: Identity, payload: Uint8Array): Uint8Array {
    const encoded = this.log.appendSigned(identity, payload);
    this.flush();
    return encoded;
  }

  /** Sends everything the relay has not confirmed. Safe to call at any time. */
  flush(): void {
    if (!this.socket) return;

    const from = this.relayTipSeq + 1;
    const through = Math.min(this.tipSeq, from + MAX_APPEND_ENTRIES - 1);
    const entries = [];

    for (let seq = from; seq <= through; seq += 1) {
      const entry = this.log.entry(seq);
      if (!entry) throw new Error(`local log has no entry ${seq}`);
      entries.push({ seq, entry: toBase64Url(entry) });
    }

    if (entries.length > 0) this.send({ t: 'append', entries });
  }

  // -- receiving ------------------------------------------------------------

  private async receive(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.events.onError?.('bad_message', 'relay sent invalid JSON');
      return;
    }

    const message = serverMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.events.onError?.('bad_message', message.error.message);
      return;
    }

    switch (message.data.t) {
      case 'state':
        return this.onState(message.data);
      case 'entries':
        return this.onEntries(message.data);
      case 'appended':
        return this.onAppended(message.data);
      case 'presence':
        return this.setPresence(message.data.others > 0);
      case 'hold':
        return this.events.onHold?.(
          message.data.body === null ? null : fromBase64Url(message.data.body),
          message.data.until,
        );
      case 'err':
        return this.onError(message.data);
    }
  }

  /**
   * Reconciles our tip with the relay's.
   *
   * Four cases, and the interesting one is the last: a relay holding nothing
   * for a game we have played is either brand new or was evicted, and in the
   * evicted case it hands back a tombstone we must satisfy before re-uploading.
   */
  private onState(state: Extract<ServerMessage, { t: 'state' }>): void {
    this.relayTipSeq = state.tipSeq;

    if (state.tipSeq < 0) {
      if (state.tombstone && this.tipSeq >= 0) {
        if (!this.checkTombstone(state.tombstone)) return;
      }
      this.flush();
      return this.settle();
    }

    if (state.tipSeq > this.tipSeq) {
      this.send({ t: 'req', fromSeq: this.tipSeq + 1 });
      return;
    }

    if (state.tipSeq === this.tipSeq) {
      // Same length: the hashes must agree, or the two of us are on different
      // histories and no amount of syncing will fix it.
      if (state.tipHash !== this.tipHashB64()) {
        this.setStatus('diverged', 'relay holds a different history at the same length');
        this.events.onError?.('chain_mismatch', 'relay tip differs from ours');
        return;
      }
      return this.settle();
    }

    // We are ahead: send what the relay is missing.
    this.flush();
    this.settle();
  }

  /**
   * Refuses to restore a log that does not contain the tombstoned tip.
   *
   * This is the anti-rollback check. Because entries are hash-chained, a log
   * containing that hash provably contains the whole evicted history; a log
   * without it would silently erase moves that were really played.
   */
  private checkTombstone(tombstone: Tombstone): boolean {
    try {
      this.log.checkTombstone(this.encodeTombstone(tombstone));
      return true;
    } catch (error) {
      this.setStatus('refused', String(error));
      this.events.onError?.('tombstone', String(error));
      return false;
    }
  }

  private encodeTombstone(tombstone: Tombstone): Uint8Array {
    return this.core.encodeTombstone(
      fromBase64Url(tombstone.gameId),
      fromBase64Url(tombstone.tipHash),
      tombstone.participantKeyHashes.map((h) => fromBase64Url(h)),
      BigInt(tombstone.timestamp),
    );
  }

  /**
   * Applies entries from the relay.
   *
   * Every entry goes through the core's verification — chaining, authorship,
   * signature — before it is accepted. The relay is a transport, and nothing it
   * says is taken on trust.
   */
  private onEntries(message: Extract<ServerMessage, { t: 'entries' }>): void {
    let applied = 0;

    for (const wire of message.entries) {
      if (wire.seq <= this.tipSeq) continue; // already have it

      try {
        this.log.append(fromBase64Url(wire.entry));
        applied++;
      } catch (error) {
        this.setStatus('refused', String(error));
        this.events.onError?.('invalid_entry', String(error));
        return;
      }
    }

    this.relayTipSeq = Math.max(this.relayTipSeq, this.tipSeq);
    if (applied > 0) this.events.onEntries?.(this.log);

    // We may still hold entries the relay has not seen.
    this.flush();
    this.settle();
  }

  /**
   * A refusal from the relay, which is usually the end of the road and once in
   * a while is a race with this person's own other device.
   */
  private onError(message: Extract<ServerMessage, { t: 'err' }>): void {
    this.events.onError?.(message.code, message.detail);

    // Our unacknowledged entries collide with something the relay already has.
    // Whatever is stored is the history — the relay never chooses between two
    // continuations, it keeps the first — so ours were a draft, not a move.
    if (message.code === 'chain_mismatch' && this.tipSeq > this.relayTipSeq) {
      return this.rollBack();
    }

    this.setStatus('refused', message.detail);
  }

  /**
   * Takes back entries the relay never accepted.
   *
   * Only ever entries past its tip. Anything it has acknowledged is somebody
   * else's history as well as ours, and a log that disagrees about those is
   * diverged rather than ahead.
   */
  private rollBack(): void {
    const from = this.relayTipSeq + 1;
    const count = this.tipSeq - this.relayTipSeq;

    this.log.truncate(from);
    this.events.onRolledBack?.(from, count);

    // And then find out what actually happened at those positions.
    this.setStatus('syncing');
    this.send({ t: 'req', fromSeq: from });
  }

  private onAppended(message: Extract<ServerMessage, { t: 'appended' }>): void {
    this.relayTipSeq = Math.max(this.relayTipSeq, message.tipSeq);
    this.flush();
    this.settle();
  }

  private settle(): void {
    this.setStatus(this.pendingCount === 0 ? 'synced' : 'syncing');
  }

  /** Registers this device to receive content-free pushes for this game. */
  subscribeToPush(subscription: PushSubscriptionJson): void {
    this.send({ t: 'push_sub', subscription });
  }

  /**
   * Tells the room this device no longer wants pushes about this game.
   *
   * The endpoint alone, because by the time anyone knows this the browser
   * subscription has been given up and there is nothing else left to name.
   */
  unsubscribeFromPush(endpoint: string): void {
    this.send({ t: 'push_sub', subscription: null, endpoint });
  }

  /**
   * Claims the next move for this device, for `ttlMs`.
   *
   * Goes to this player's own other sockets and nowhere else. Renewing is
   * simply claiming again — the relay keeps one claim per participant.
   */
  hold(body: Uint8Array, ttlMs: number): void {
    this.send({ t: 'hold', body: toBase64Url(body), ttlMs });
  }

  /** Gives the claim up, so another device can take the turn immediately. */
  release(): void {
    this.send({ t: 'release' });
  }
}
