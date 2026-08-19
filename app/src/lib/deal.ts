/**
 * The deal, kept in step with one game's log.
 *
 * The rules and the cryptography are deliberately ignorant of each other. The
 * rules cannot verify a decryption share — they link nothing that could — and
 * the deal has never heard of a word. This is the piece in between, and it owes
 * three things to each entry that arrives, in this order:
 *
 * 1. Apply the deal payload, which verifies every proof inside it.
 * 2. Check that what the *move* claims matches what the deal actually opened.
 * 3. Only then let the rules apply the move.
 *
 * Skip the middle step and a player can name any tile they like while attaching
 * a perfectly valid payload about a different one. Neither half catches that
 * alone, which is exactly why it is easy to leave out.
 *
 * ## Why it is worth caching
 *
 * Verifying a shuffle costs real time, and the board is rebuilt from the whole
 * log on every render. Verification is monotone, though — an entry accepted
 * once stays accepted — so the state after entry N is a fact worth writing
 * down. The snapshot is stored against the tip it was taken at, and thrown away
 * if the log it is handed does not match, which makes a stale one impossible
 * rather than merely unlikely.
 */
import { fromBase64Url, toBase64Url } from '@tabla/shared';

import { getDealSnapshot, putDealSnapshot } from './db/store.ts';
import type { CoreModule, DealSession, Identity } from './wasm/core.ts';

/** Tile kinds in the word game: a blank and twenty-six letters. */
const TILE_KINDS = 27;

/** A move as the word game's rules encode it, before the host fills in the deal. */
export interface DealAwareMove {
  action: unknown;
  deal?: number[] | null;
}

/** What the rules say this entry owes the deal. */
export interface DealDuty {
  /** Tiles to hand the opponent, replacing what they spent. */
  owed: number;
  /** Positions to open to everyone: a play, or a rack at the end. */
  reveal: number[];
}

/**
 * One game's deal, advanced entry by entry.
 *
 * Holds the device's key share for the length of the game and never writes it
 * down: it is derived from the identity seed, so a restored backup recomputes
 * it and can read a rack it was dealt before the backup was taken.
 */
export class Deal {
  private constructor(
    private readonly session: DealSession,
    private readonly gameId: string,
    private readonly player: number,
    /** The highest entry already applied. -1 means none. */
    private applied: number,
  ) {}

  /**
   * Builds a deal for one game, resuming from a snapshot when there is a usable
   * one.
   *
   * `deck` is the canonical bag, which both devices compute for themselves —
   * that is why establishing it costs no log entries.
   */
  static async open(options: {
    core: CoreModule;
    identity: Identity;
    gameId: string;
    player: number;
    deck: Uint8Array;
    /** The log's tip hash at each sequence, for checking a snapshot. */
    hashAt: (seq: number) => Uint8Array | null;
  }): Promise<Deal> {
    const { core, identity, gameId, player, deck, hashAt } = options;
    const bytes = fromBase64Url(gameId);
    const secret = identity.deriveDealSecret(bytes);

    const saved = await getDealSnapshot(gameId);
    if (saved) {
      // A snapshot is only worth anything against the log it was taken from.
      // Comparing the tip hash is what makes a stale one impossible rather
      // than unlikely — a restored backup, a diverged relay, a half-written
      // entry all fail this and simply cost a re-verify.
      const expected = hashAt(saved.tipSeq);
      if (expected && toBase64Url(expected) === saved.tipHash) {
        try {
          return new Deal(
            core.DealSession.restore(bytes, player, secret, TILE_KINDS, saved.snapshot),
            gameId,
            player,
            saved.tipSeq,
          );
        } catch {
          // A snapshot this build cannot read is not an error worth surfacing;
          // the log is the truth and re-verifying it costs a moment.
        }
      }
    }

    return new Deal(
      new core.DealSession(bytes, player, secret, deck, TILE_KINDS),
      gameId,
      player,
      -1,
    );
  }

  /** Whether the opening ceremony is finished. */
  get ready(): boolean {
    return this.session.ready;
  }

  /** What the ceremony still wants from this device: `key`, `shuffle`, `play`. */
  get step(): string {
    return this.session.step;
  }

  /** Tiles never dealt. */
  get remaining(): number {
    return this.session.remaining;
  }

  /**
   * Everything this device can read, as the rules' private blob.
   *
   * Postcard: the player index, then a length-prefixed list of
   * `(position, tile)` pairs. Hand-encoded because it is two integers and a
   * byte, and reaching for a library to write six bytes would be worse.
   */
  privateBlob(): Uint8Array {
    const visible = this.session.visibleTiles();
    const pairs = visible.length / 2;

    const out: number[] = [this.player];
    pushVarint(out, pairs);
    for (let i = 0; i < visible.length; i += 2) {
      pushVarint(out, visible[i]);
      out.push(visible[i + 1] & 0xff);
    }
    return new Uint8Array(out);
  }

  /**
   * Brings the deal up to date with the log.
   *
   * `entries` are the decoded moves from sequence 2 onward, in order. Only
   * those past what has already been applied are touched, so a render costs
   * nothing when nothing has changed.
   *
   * Runs one at a time. Entries arrive from the relay without waiting for the
   * render they trigger, so two passes can otherwise overlap — and both would
   * see the same un-advanced deal and apply the same entry, which the second
   * time is a player publishing two key shares. The protocol is right to refuse
   * that; the caller was wrong to ask twice.
   */
  advance(
    entries: { seq: number; author: number; deal: Uint8Array | null }[],
    tip: { seq: number; hash: Uint8Array | null },
  ): Promise<void> {
    const run = this.queue.then(() => this.advanceNow(entries, tip));
    // The chain must survive a rejection, or one bad entry would wedge every
    // later one behind it.
    this.queue = run.catch(() => {});
    return run;
  }

  /** Serializes `advance`, which is not safe to run twice at once. */
  private queue: Promise<void> = Promise.resolve();

  private async advanceNow(
    entries: { seq: number; author: number; deal: Uint8Array | null }[],
    tip: { seq: number; hash: Uint8Array | null },
  ): Promise<void> {
    let moved = false;

    for (const entry of entries) {
      if (entry.seq <= this.applied) continue;
      if (entry.deal) this.session.applyEntry(entry.author, entry.seq, entry.deal);
      this.applied = entry.seq;
      moved = true;
    }

    if (!moved || !tip.hash) return;

    await putDealSnapshot({
      gameId: this.gameId,
      tipSeq: tip.seq,
      tipHash: toBase64Url(tip.hash),
      snapshot: this.session.snapshot(),
    });
  }

  /**
   * Builds the deal payload an entry has to carry.
   *
   * Two sources, and neither knows what the other knows: the deal says what the
   * ceremony still owes, and the rules say how many tiles to hand over and what
   * to open. Assembling them is the whole job of this layer.
   */
  payload(seq: number, duty: DealDuty): Uint8Array | null {
    const entropy = randomEntropy();

    if (this.step === 'key') {
      // The second player to speak completes the joint key, so their shuffle
      // can ride the same entry.
      return this.session.readyForShuffleAfterKey
        ? this.session.keyAndShufflePayload(seq, entropy)
        : this.session.keyPayload(seq, entropy);
    }

    if (this.step === 'shuffle') {
      return this.session.shufflePayload(seq, duty.owed, entropy);
    }

    if (duty.reveal.length > 0) {
      return this.session.revealAndDealPayload(
        seq,
        new Uint16Array(duty.reveal),
        duty.owed,
        entropy,
      );
    }

    if (duty.owed > 0) return this.session.dealPayload(seq, duty.owed, entropy);

    return null;
  }

  /**
   * Checks that a move's claims match what the deal actually opened.
   *
   * The step neither half can do alone. A tile named in a play, or in a rack
   * opened at the end, has to be one this device has seen opened — otherwise a
   * player could attach a valid payload about one position and claim another.
   */
  agrees(claims: { position: number; tile: number }[]): boolean {
    return claims.every((claim) => this.session.tile(claim.position) === claim.tile);
  }
}

function pushVarint(out: number[], value: number): void {
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  out.push(rest);
}

function randomEntropy(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
