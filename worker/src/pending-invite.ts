/**
 * The pending-invite Durable Object.
 *
 * One instance per invite, addressed by `idFromName(blobId)`. It holds a blob it
 * cannot read (the key lives in the share link's fragment) and enforces the one
 * property that matters: an invite link can be redeemed exactly once.
 */
import { DurableObject } from 'cloudflare:workers';

import { ErrorCode, INVITE_TTL_MS, toBase64Url } from '@tabla/shared';

import type { Env } from './env.ts';

export interface ClaimResult {
  ok: boolean;
  /** The sealed config blob, base64url, present only on a successful claim. */
  blob?: string;
  code?: string;
}

export interface InviteStatus {
  exists: boolean;
  claimed: boolean;
  claimerPubKey?: string;
  sig?: string;
  expiresAt?: number;
}

export class PendingInviteDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS invite (
          blob_id     TEXT PRIMARY KEY,
          blob        BLOB NOT NULL,
          claimed_by  TEXT,
          claim_sig   TEXT,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL
        )
      `);
    });
  }

  /** Stores a sealed invite and schedules its expiry. */
  async create(blobId: string, blob: ArrayBuffer, now: number): Promise<{ expiresAt: number }> {
    const expiresAt = now + INVITE_TTL_MS;

    this.ctx.storage.sql.exec(
      `INSERT INTO invite (blob_id, blob, created_at, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(blob_id) DO NOTHING`,
      blobId,
      blob,
      now,
      expiresAt,
    );

    await this.ctx.storage.setAlarm(expiresAt);
    return { expiresAt };
  }

  /**
   * Redeems the invite, binding the claimer's identity to it.
   *
   * The single-use guarantee is the `claimed_by IS NULL` predicate: a second
   * claim updates no rows and is refused. Durable Object execution is
   * single-threaded per instance, so two simultaneous claims cannot both see a
   * null and both write.
   *
   * The signature is stored, not checked. The relay is not trusted to
   * authenticate anyone — the initiator verifies it against the claimed key.
   */
  async claim(claimerPubKey: string, sig: string, now: number): Promise<ClaimResult> {
    const row = this.ctx.storage.sql
      .exec<{ blob: ArrayBuffer; claimed_by: string | null; expires_at: number }>(
        `SELECT blob, claimed_by, expires_at FROM invite LIMIT 1`,
      )
      .toArray()[0];

    if (!row) return { ok: false, code: ErrorCode.NotFound };
    if (now >= row.expires_at) return { ok: false, code: ErrorCode.Expired };
    if (row.claimed_by !== null) return { ok: false, code: ErrorCode.AlreadyClaimed };

    const cursor = this.ctx.storage.sql.exec(
      `UPDATE invite SET claimed_by = ?, claim_sig = ? WHERE claimed_by IS NULL`,
      claimerPubKey,
      sig,
    );

    if (cursor.rowsWritten === 0) return { ok: false, code: ErrorCode.AlreadyClaimed };

    return { ok: true, blob: toBase64Url(new Uint8Array(row.blob)) };
  }

  /** What the initiator polls to learn who redeemed its link. */
  async status(): Promise<InviteStatus> {
    const row = this.ctx.storage.sql
      .exec<{ claimed_by: string | null; claim_sig: string | null; expires_at: number }>(
        `SELECT claimed_by, claim_sig, expires_at FROM invite LIMIT 1`,
      )
      .toArray()[0];

    if (!row) return { exists: false, claimed: false };

    return {
      exists: true,
      claimed: row.claimed_by !== null,
      claimerPubKey: row.claimed_by ?? undefined,
      sig: row.claim_sig ?? undefined,
      expiresAt: row.expires_at,
    };
  }

  /** Expiry. An unclaimed link stops working after seven days. */
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM invite`);
  }
}
