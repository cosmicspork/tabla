/**
 * One live game, from the UI's point of view.
 *
 * Owns the local log, the sync engine, and the persistence of both, and hands
 * the board out as a plain view object the UI can render. Keeps Svelte out of
 * it entirely so the same logic can be exercised without a browser.
 */
import { fromBase64Url, toBase64Url } from '@tabla/shared';

import { appendEntries, loadEntries, updateGame } from './db/store.ts';
import type { GameRecord } from './db/schema.ts';
import { loadIdentity, randomBytes } from './identity.ts';
import { dictionaryBytes } from './dict.ts';
import { pluginHost } from './plugin/host.ts';
import type { PluginOutcome } from './plugin/protocol.ts';
import { openGameSocket } from './relay.ts';
import { SyncEngine, type SyncStatus } from './sync/engine.ts';
import type { CoreModule, Identity, Log, Session } from './wasm/core.ts';

export interface BoardState {
  view: Record<string, unknown>;
  outcome: PluginOutcome | null;
  /** Our own player index: 0 for the initiator, 1 for the claimer. */
  player: number;
  /** How many entries the relay has yet to confirm. */
  pending: number;
  status: SyncStatus;
}

export class GameSession {
  private engine: SyncEngine | null = null;
  private log!: Log;
  private session!: Session;
  private core!: CoreModule;
  private identity!: Identity;

  readonly listeners = new Set<(state: BoardState) => void>();

  private syncStatus: SyncStatus = 'idle';
  private lastError: string | null = null;

  private constructor(private game: GameRecord) {}

  static async open(game: GameRecord): Promise<GameSession> {
    const instance = new GameSession(game);
    await instance.initialize();
    return instance;
  }

  get record(): GameRecord {
    return this.game;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** Our player index, which is fixed by which side of the invite we were on. */
  get player(): number {
    return this.game.role === 'initiator' ? 0 : 1;
  }

  private async initialize(): Promise<void> {
    // The sandbox cannot fetch anything, so the main thread supplies the word
    // list when the rules ask for it.
    pluginHost().useAssetSource(dictionaryBytes);

    const { core, identity } = await loadIdentity();
    this.core = core;
    this.identity = identity;

    if (!this.game.claimerPubKey) {
      throw new Error('the game has not been claimed yet');
    }

    const gameId = fromBase64Url(this.game.gameId);
    const initiator = fromBase64Url(this.game.initiatorPubKey);
    const claimer = fromBase64Url(this.game.claimerPubKey);
    const peer = this.game.role === 'initiator' ? claimer : initiator;

    const key = identity.agreeGameKey(peer, fromBase64Url(this.game.blobId), gameId);
    this.session = new core.Session(gameId, key, initiator, claimer);
    this.log = new core.Log(gameId, initiator, claimer);

    // Rebuilding from storage re-verifies every entry: chaining, authorship,
    // and signatures. Nothing is trusted just because we wrote it down before.
    for (const entry of await loadEntries(this.game.gameId)) {
      this.log.append(entry);
    }
  }

  // -- syncing --------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.engine) return;

    this.engine = new SyncEngine({
      core: this.core,
      gameId: this.game.gameId,
      keyHash: this.identity.keyHash(),
      log: this.log,
      transport: openGameSocket,
      onEntries: () => void this.persistAndNotify(),
      onStatus: (status) => {
        this.syncStatus = status;
        void this.notify();
      },
      onError: (code, detail) => {
        this.lastError = detail ?? code;
        void this.notify();
      },
    });

    await this.engine.connect();
  }

  disconnect(): void {
    this.engine?.disconnect();
    this.engine = null;
  }

  /** Called when the app regains focus or a push arrives. */
  async resync(): Promise<void> {
    this.disconnect();
    await this.connect();
  }

  // -- playing --------------------------------------------------------------

  /**
   * Writes the entries that start a game.
   *
   * The claimer opens with a `Join` binding its key; the initiator answers with
   * the configuration. Both are ordinary log entries, so the handshake is
   * verifiable after the fact like everything else.
   */
  async writePrologueIfNeeded(): Promise<void> {
    this.writePrologueEntry();
    await this.persistAndNotify();
  }

  /**
   * Writes our half of the prologue if the log is now waiting for it.
   *
   * This has to be re-checked every time the log advances, not just on connect:
   * the initiator usually opens the board before the claimer's `Join` has
   * arrived, so at that moment there is nothing for it to answer. Checking only
   * once would leave the game stuck at sequence 0 forever.
   *
   * Returns whether an entry was written.
   */
  private writePrologueEntry(): boolean {
    const tip = Number(this.log.tipSeq);

    if (tip < 0 && this.game.role === 'claimer') {
      this.appendEntry(this.session.sealJoin(randomBytes(24), this.identity.publicKey()));
      return true;
    }
    if (tip === 0 && this.game.role === 'initiator') {
      this.appendEntry(this.session.sealSetup(randomBytes(24), this.setupConfig()));
      return true;
    }
    return false;
  }

  /**
   * The configuration the initiator writes into the log at sequence 1.
   *
   * It repeats what the invite already said, which is the point: the invite is
   * out of band and gone once redeemed, while this is inside the signed log and
   * verifiable for as long as the game exists.
   */
  private setupConfig(): Uint8Array {
    if (!this.game.dictionary) return new Uint8Array();

    // Version byte, then the hash of the word list both players agreed to.
    const hash = this.game.dictionary;
    const config = new Uint8Array(1 + hash.length / 2);
    config[0] = 1;
    for (let i = 0; i < hash.length / 2; i += 1) {
      config[i + 1] = Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16);
    }
    return config;
  }

  /**
   * Plays a move.
   *
   * It is validated by the plugin before it is signed, so an illegal move never
   * reaches the log — the opponent would reject it anyway, and a rejected entry
   * cannot be withdrawn once written.
   */
  async play(move: unknown): Promise<void> {
    const replay = this.log.replay(this.session);
    const moves = [...replay.moves];
    const encoded = await pluginHost().encodeMove(this.game.pluginId, move);

    await pluginHost().validate({
      pluginId: this.game.pluginId,
      config: replay.config ?? new Uint8Array(),
      seed: fromBase64Url(this.game.seed),
      moves,
      move: encoded,
      player: this.player,
      assetHash: this.game.dictionary,
    });

    const seq = Number(this.log.tipSeq) + 1;
    this.appendEntry(this.session.sealMove(seq, randomBytes(24), encoded));
    await this.persistAndNotify();
  }

  async resign(): Promise<void> {
    const seq = Number(this.log.tipSeq) + 1;
    this.appendEntry(this.session.sealResign(seq, randomBytes(24)));
    await this.persistAndNotify();
  }

  /**
   * Signs a payload into the log, whether or not the relay is reachable.
   *
   * A move made offline is a real move: it is committed locally now and sent
   * whenever a connection returns.
   */
  private appendEntry(payload: Uint8Array): void {
    if (this.engine) this.engine.appendLocal(this.identity, payload);
    else this.log.appendSigned(this.identity, payload);
  }

  // -- rendering ------------------------------------------------------------

  async board(): Promise<BoardState> {
    const replay = this.log.replay(this.session);

    const { view, outcome } = await pluginHost().view({
      pluginId: this.game.pluginId,
      config: replay.config ?? new Uint8Array(),
      seed: fromBase64Url(this.game.seed),
      moves: [...replay.moves],
      player: this.player,
      assetHash: this.game.dictionary,
    });

    // A resignation ends the game even though the rules know nothing about it.
    const resignedBy = replay.resignedBy;
    const finalOutcome: PluginOutcome | null =
      resignedBy === undefined
        ? (outcome as PluginOutcome | null)
        : { kind: 'winner', player: resignedBy === 0 ? 1 : 0 };

    return {
      view,
      outcome: finalOutcome,
      player: this.player,
      pending: this.engine?.pendingCount ?? 0,
      status: this.syncStatus,
    };
  }

  subscribe(listener: (state: BoardState) => void): () => void {
    this.listeners.add(listener);
    void this.notify();
    return () => this.listeners.delete(listener);
  }

  private async notify(): Promise<void> {
    if (this.listeners.size === 0) return;
    const state = await this.board();
    for (const listener of this.listeners) listener(state);
  }

  /** Mirrors the in-memory log into storage, then re-renders. */
  private async persistAndNotify(): Promise<void> {
    // Entries arriving from the opponent may be exactly what we were waiting
    // for before we can write our own half of the handshake.
    this.writePrologueEntry();

    const stored = await loadEntries(this.game.gameId);
    const tip = Number(this.log.tipSeq);

    const fresh: { seq: number; entry: Uint8Array }[] = [];
    for (let seq = stored.length; seq <= tip; seq++) {
      const entry = this.log.entry(seq);
      if (entry) fresh.push({ seq, entry });
    }

    if (fresh.length > 0) {
      await appendEntries(this.game.gameId, fresh, Date.now());
    }

    const board = await this.board();
    if (board.outcome && this.game.status !== 'finished') {
      this.game =
        (await updateGame(this.game.gameId, {
          status: 'finished',
          outcome: describeOutcome(board.outcome, this.player),
        })) ?? this.game;
    }

    await this.notify();
  }

  /** Registers this device for content-free pushes about this game. */
  subscribeToPush(subscription: PushSubscriptionJSON): void {
    this.engine?.subscribeToPush(subscription as never);
  }

  get gameKeyHash(): string {
    return toBase64Url(this.identity.keyHash());
  }
}

export function describeOutcome(outcome: PluginOutcome, player: number): string {
  if (outcome.kind === 'draw') return 'Draw';
  return outcome.player === player ? 'You won' : 'You lost';
}
