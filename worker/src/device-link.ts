/**
 * The device-link Durable Object.
 *
 * One instance per link, addressed by `idFromName(linkId)`. It holds one sealed
 * bundle — a whole installation, encrypted under six words the person reads or
 * scans from their other device — and hands it over exactly once.
 *
 * Close kin to `PendingInviteDO`, and deliberately not the same class. Three
 * things differ, and each of them is the point:
 *
 * - **The client names it.** The id is derived from the same words that are the
 *   passphrase, so the relay never chooses it and cannot enumerate what it
 *   holds. Since a client picks the name, two links could collide; the second
 *   is refused rather than allowed to overwrite the first.
 * - **It lasts ten minutes**, not seven days. The blob is an identity under a
 *   spoken passphrase, so the window it exists in is most of what protects it.
 * - **Taking it deletes it.** An invite keeps its blob so the initiator can
 *   poll for who claimed it. Here both ends are the same person and there is
 *   nobody to tell, so the bundle goes the moment it is collected.
 */
import { DurableObject } from 'cloudflare:workers';

import { ErrorCode, LINK_TTL_MS, toBase64Url } from '@tabla/shared';

import type { Env } from './env.ts';
import { constantTimeEqual } from './util.ts';

export interface LinkResult {
  ok: boolean;
  /** The sealed bundle, base64url, present only on a successful take. */
  blob?: string;
  code?: string;
}

export interface LinkStatus {
  exists: boolean;
  taken: boolean;
  expiresAt?: number;
}

export class DeviceLinkDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS link (
          link_id      TEXT PRIMARY KEY,
          blob         BLOB,
          cancel_token TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          expires_at   INTEGER NOT NULL,
          taken_at     INTEGER
        )
      `);
    });
  }

  /**
   * Opens a link, if that name is free.
   *
   * An unexpired row under the same id is a genuine collision — two devices
   * drew the same six words, which at 66 bits will not happen, or someone is
   * guessing. Either way the offering device redraws rather than overwriting
   * whatever is there.
   */
  async create(
    linkId: string,
    blob: ArrayBuffer,
    cancelToken: string,
    now: number,
  ): Promise<{ ok: boolean; expiresAt?: number; code?: string }> {
    const existing = this.row();
    if (existing && now < existing.expires_at) {
      return { ok: false, code: ErrorCode.Conflict };
    }

    const expiresAt = now + LINK_TTL_MS;
    this.ctx.storage.sql.exec(`DELETE FROM link`);
    this.ctx.storage.sql.exec(
      `INSERT INTO link (link_id, blob, cancel_token, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      linkId,
      blob,
      cancelToken,
      now,
      expiresAt,
    );

    await this.ctx.storage.setAlarm(expiresAt);
    return { ok: true, expiresAt };
  }

  /**
   * Collects the bundle, once.
   *
   * The `blob IS NOT NULL` predicate is the single-use guarantee, and a Durable
   * Object runs one request at a time, so two devices racing cannot both read a
   * blob and both clear it. The row itself stays until expiry so the offering
   * device's next poll can say the link was taken rather than that it vanished.
   */
  async take(now: number): Promise<LinkResult> {
    const row = this.row();

    if (!row) return { ok: false, code: ErrorCode.NotFound };
    if (now >= row.expires_at) return { ok: false, code: ErrorCode.Expired };
    if (row.blob === null) return { ok: false, code: ErrorCode.AlreadyClaimed };

    const cursor = this.ctx.storage.sql.exec(
      `UPDATE link SET blob = NULL, taken_at = ? WHERE blob IS NOT NULL`,
      now,
    );
    if (cursor.rowsWritten === 0) return { ok: false, code: ErrorCode.AlreadyClaimed };

    return { ok: true, blob: toBase64Url(new Uint8Array(row.blob)) };
  }

  /** Withdraws a link, whether or not it has been taken. */
  async cancel(cancelToken: string): Promise<{ ok: boolean; code?: string }> {
    const row = this.row();

    if (!row) return { ok: false, code: ErrorCode.NotFound };
    if (!constantTimeEqual(row.cancel_token, cancelToken)) {
      return { ok: false, code: ErrorCode.Forbidden };
    }

    this.ctx.storage.sql.exec(`DELETE FROM link`);
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  /** What the offering device polls, to know when to stop showing the words. */
  async status(now: number): Promise<LinkStatus> {
    const row = this.row();
    if (!row || now >= row.expires_at) return { exists: false, taken: false };

    return { exists: true, taken: row.blob === null, expiresAt: row.expires_at };
  }

  /** Expiry. Ten minutes, and the bundle is gone whether or not it was used. */
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM link`);
  }

  /** One row per instance, so no `WHERE` is needed to find it. */
  private row(): LinkRow | undefined {
    return this.ctx.storage.sql
      .exec<LinkRow>(`SELECT blob, cancel_token, expires_at FROM link LIMIT 1`)
      .toArray()[0];
  }
}

/** A type alias, not an interface: `sql.exec<T>` requires an index signature. */
type LinkRow = {
  blob: ArrayBuffer | null;
  cancel_token: string;
  expires_at: number;
};
