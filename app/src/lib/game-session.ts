/**
 * One live game, from the UI's point of view.
 *
 * Owns the local log, the sync engine, and the persistence of both, and hands
 * the board out as a plain view object the UI can render. Keeps Svelte out of
 * it entirely so the same logic can be exercised without a browser.
 */
import { fromBase64Url, toBase64Url } from '@tabla/shared';

import { Deal, type DealDuty } from './deal.ts';
import { appendEntries, loadEntries, updateGame } from './db/store.ts';
import type { GameRecord } from './db/schema.ts';
import { loadIdentity, randomBytes } from './identity.ts';
import { dictionaryBytes } from './dict.ts';
import { pluginBytes } from './plugin/install.ts';
import { gameEntry } from './registry.ts';
import { pluginHost } from './plugin/host.ts';
import type { PluginOutcome } from './plugin/protocol.ts';
import { openGameSocket } from './relay.ts';
import { SyncEngine, type SyncStatus } from './sync/engine.ts';
import type { CoreModule, Identity, Log, Session } from './wasm/core.ts';

export interface BoardState {
  /**
   * Whether the game has actually begun.
   *
   * A game starts with two entries — the claimer binding their key, the
   * initiator writing the configuration — and neither client can render
   * anything until both are in the log. Tic tac toe would have survived being
   * asked early, because it ignores its configuration; a game that pins a word
   * list in it cannot, and should not.
   */
  ready: boolean;
  view: Record<string, unknown>;
  outcome: PluginOutcome | null;
  /** Our own player index: 0 for the initiator, 1 for the claimer. */
  player: number;
  /** How many entries the relay has yet to confirm. */
  pending: number;
  status: SyncStatus;
  /**
   * Whether the opponent is connected right now.
   *
   * Nothing depends on this — a game plays exactly the same either way — but
   * knowing someone is at the other end changes how long a person is willing
   * to sit and wait for their move.
   */
  opponentPresent: boolean;
  /**
   * Who gave up, if anyone.
   *
   * Carried separately from `outcome` because a resignation and a defeat are
   * the same result and a different event, and a game list that calls them both
   * "You lost" is telling you less than it knows.
   */
  resignedBy?: number;
}

export class GameSession {
  private engine: SyncEngine | null = null;
  /** Set only for games whose hidden state lives in an encrypted deck. */
  private deal: Deal | null = null;
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
    // The sandbox cannot fetch anything, so the main thread supplies both the
    // rules and the word list when it asks for them. Both are checked against
    // the signed manifest before they get anywhere near the worker.
    pluginHost().useAssetSource(dictionaryBytes);
    pluginHost().useModuleSource(pluginBytes);

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

    const entry = gameEntry(this.game.pluginId, this.game.pluginVersion);
    if (entry?.seed === 'deal') {
      this.deal = await Deal.open({
        core,
        identity,
        gameId: this.game.gameId,
        player: this.player,
        deck: await pluginHost().deck(this.game.pluginId, this.game.pluginVersion),
        hashAt: (seq) => this.hashAt(seq),
      });
      await this.syncDeal();
    }
  }

  /** The log's tip hash at a sequence, for checking a saved deal against it. */
  private hashAt(seq: number): Uint8Array | null {
    if (seq !== Number(this.log.tipSeq)) return null;
    return this.log.tipHash ?? null;
  }

  /**
   * Brings the deal up to the log's tip, verifying whatever is new.
   *
   * Every proof in every entry is checked here and nowhere else. A failure is
   * an entry we refuse: the deal keeps the state it had, and the game carries
   * on from where it was rather than half-advancing into something neither
   * device would agree about.
   */
  private async syncDeal(): Promise<void> {
    if (!this.deal) return;
    if (Number(this.log.tipSeq) <= this.dealSyncedTo) return;

    const replay = this.log.replay(this.session);
    const moves = [...replay.moves];

    // Serially: the first decode may have to fetch the rules module, and a
    // burst of concurrent requests would each try to supply it.
    const entries = [];
    for (const [index, move] of moves.entries()) {
      // Moves start at sequence 2, after the claimer's join and the setup.
      const seq = index + 2;
      entries.push({
        seq,
        author: index % 2,
        deal: await this.dealPayloadOf(seq, move),
      });
    }

    const tip = Number(this.log.tipSeq);
    await this.deal.advance(entries, { seq: tip, hash: this.log.tipHash ?? null });
    this.dealSyncedTo = tip;
  }

  /** The log tip the deal has already been brought up to. */
  private dealSyncedTo = -1;

  /**
   * Decoded deal payloads, by sequence.
   *
   * Entries are immutable once written, so a payload read out of one is worth
   * keeping: without this, every render would decode every move again through
   * the worker.
   */
  private readonly payloads = new Map<number, Uint8Array | null>();

  /**
   * The deal payload carried by an encoded move, if it has one.
   *
   * Deliberately not forgiving. A move this device cannot read is a move it
   * cannot verify, and quietly treating it as carrying nothing would leave the
   * deal a step behind the log — where every later proof fails against a deck
   * that has moved on without it.
   */
  private async dealPayloadOf(seq: number, move: Uint8Array): Promise<Uint8Array | null> {
    const cached = this.payloads.get(seq);
    if (cached !== undefined) return cached;

    const decoded = JSON.parse(
      await pluginHost().decodeMove(this.game.pluginId, this.game.pluginVersion, move),
    ) as { deal?: number[] | null };

    const payload = decoded.deal ? new Uint8Array(decoded.deal) : null;
    this.payloads.set(seq, payload);
    return payload;
  }

  /** What this device knows privately: a deal's opened tiles, or its seed. */
  private privateBytes(): Uint8Array {
    return this.deal ? this.deal.privateBlob() : fromBase64Url(this.game.seed);
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
      onPresence: () => void this.notify(),
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
    // The version is the rules' config format, which moves with the rules.
    const hash = this.game.dictionary;
    const config = new Uint8Array(1 + hash.length / 2);
    config[0] = this.game.pluginVersion;
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
    const seq = Number(this.log.tipSeq) + 1;

    const complete = this.wrap(move, seq);

    const encoded = await pluginHost().encodeMove(
      this.game.pluginId,
      this.game.pluginVersion,
      complete,
    );

    const config = replay.config ?? new Uint8Array();
    await pluginHost().validate({
      pluginId: this.game.pluginId,
      pluginVersion: this.game.pluginVersion,
      config,
      seed: this.privateBytes(),
      moves,
      move: encoded,
      player: this.player,
      assetHash: assetHashOf(config),
    });

    this.appendEntry(this.session.sealMove(seq, randomBytes(24), encoded));
    await this.persistAndNotify();
  }

  /**
   * What the last rendered view said the next entry has to carry.
   *
   * The rules work this out and the client supplies it: how many tiles to deal,
   * which positions to open, and — for the older rules — the rack commitment
   * they expect back verbatim.
   */
  private duty: DealDuty & { rackCommitment: unknown } = {
    owed: 0,
    reveal: [],
    rackCommitment: null,
  };

  /**
   * Wraps a game action in whatever else its rules want carried.
   *
   * Kept here rather than in the board because it is bookkeeping, not play, and
   * because what a move needs alongside the action differs by version — a
   * board that had to know would have to be rewritten for each.
   */
  private wrap(move: unknown, seq: number): unknown {
    const entry = gameEntry(this.game.pluginId, this.game.pluginVersion);
    const action = (move as { action?: unknown }).action ?? move;

    if (entry?.seed === 'deal') {
      // What a move has to open comes from the move itself — the tiles it
      // spends — while what it has to deal comes from the rules. The closing
      // rack is the one case the rules name, because nothing is being spent.
      const duty = {
        owed: this.duty.owed,
        reveal: opened(action, this.duty.reveal),
      };
      const payload = this.deal?.payload(seq, duty) ?? null;
      return { action, deal: payload ? [...payload] : null };
    }

    if (entry?.seed === 'draw') {
      // The nonce keys the opponent's next draw, so it has to be real
      // randomness — anything predictable would hand them their tiles early.
      return {
        nonce: [...randomBytes(24)],
        rackCommitment: this.duty.rackCommitment ?? null,
        action,
      };
    }

    return move;
  }

  /**
   * Submits the move the rules asked for on the player's behalf.
   *
   * Key shares, shuffles, dealing, forfeits and the closing openings are
   * protocol rather than play. Driven from here and keyed on the log position
   * rather than on what the move says, because the same move can legitimately
   * come round again — two forfeits in one game are identical, and suppressing
   * the second would wedge the game.
   */
  private async driveAutomatic(board: BoardState): Promise<void> {
    const auto = board.view.auto;
    if (!auto || !board.view.yourTurn || board.outcome) return;

    const at = Number(this.log.tipSeq);
    if (at === this.lastAutoAt) return;
    this.lastAutoAt = at;

    try {
      await this.play(auto);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /** The log position the last automatic move was made at. */
  private lastAutoAt = -1;

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
    const waiting = {
      ready: false as const,
      view: {},
      outcome: null,
      player: this.player,
      pending: this.engine?.pendingCount ?? 0,
      status: this.syncStatus,
      opponentPresent: this.engine?.opponentPresent ?? false,
    };

    // Sequence 0 is the claimer's join and sequence 1 the initiator's setup.
    // Until both have arrived there is no configured game to show.
    if (Number(this.log.tipSeq) < 1) return waiting;

    // Before anything reads the deal. Renders are triggered from several
    // places — new entries, sync status, the opponent arriving — and a board
    // drawn from a deal that has not caught up would be a board the game has
    // already moved past. Cheap when there is nothing new.
    await this.syncDeal();

    const replay = this.log.replay(this.session);

    const config = replay.config ?? new Uint8Array();
    const { view, outcome } = await pluginHost().view({
      pluginId: this.game.pluginId,
      pluginVersion: this.game.pluginVersion,
      config,
      seed: this.privateBytes(),
      moves: [...replay.moves],
      player: this.player,
      assetHash: assetHashOf(config),
    });

    // Remember what the rules want of the next entry, so `play` can build it.
    this.duty = {
      owed: typeof view.owed === 'number' ? view.owed : 0,
      reveal: Array.isArray(view.toOpen) ? (view.toOpen as number[]) : [],
      rackCommitment: view.rackCommitment ?? null,
    };

    // A resignation ends the game even though the rules know nothing about it.
    const resignedBy = replay.resignedBy;
    const finalOutcome: PluginOutcome | null =
      resignedBy === undefined
        ? (outcome as PluginOutcome | null)
        : { kind: 'winner', player: resignedBy === 0 ? 1 : 0 };

    return {
      ready: true,
      view,
      outcome: finalOutcome,
      resignedBy,
      player: this.player,
      pending: this.engine?.pendingCount ?? 0,
      status: this.syncStatus,
      opponentPresent: this.engine?.opponentPresent ?? false,
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

    // After the render, so the board a player is looking at is never a
    // position the game has already moved past.
    await this.driveAutomatic(state);
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
          outcome: describeOutcome(board.outcome, this.player, board.resignedBy),
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

/**
 * Which reference data a game needs, read out of its own setup entry.
 *
 * Derived from the log rather than kept beside it, for the same reason the draw
 * seed is: the log is what a backup carries and what both players verified, so
 * anything derivable from it needs no separate field to lose. The setup entry
 * is a version byte followed by the hash of the word list both players agreed
 * to when the invite was made.
 */
function assetHashOf(config: Uint8Array): string | undefined {
  // Any config version this build knows: the first byte names the rules'
  // format, and every one of them so far is a hash in the same place.
  if (config.length !== 33 || config[0] < 1 || config[0] > 2) return undefined;

  return [...config.slice(1)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The deck positions a move makes public.
 *
 * A play opens the tiles it puts down; opening a rack at the end names its own.
 * Anything else opens nothing, and reading that off the action rather than off
 * the board state is what keeps the payload matched to the move it travels with.
 */
function opened(action: unknown, ending: number[]): number[] {
  const named = action as {
    place?: { placements?: { position?: number }[] };
    openRack?: { tiles?: [number, number][] };
  };

  if (named.place?.placements) {
    return named.place.placements
      .map((placement) => placement.position)
      .filter((position): position is number => typeof position === 'number');
  }

  if (named.openRack?.tiles) return named.openRack.tiles.map(([position]) => position);

  return ending;
}

/**
 * How a finished game is described in the list.
 *
 * A resignation is a win for somebody, but calling it that reads as though the
 * game was played out. Both players are told the same thing about it.
 */
export function describeOutcome(
  outcome: PluginOutcome,
  player: number,
  resignedBy?: number,
): string {
  if (resignedBy !== undefined) return resignedBy === player ? 'You resigned' : 'They resigned';
  if (outcome.kind === 'draw') return 'Draw';
  return outcome.player === player ? 'You won' : 'You lost';
}
