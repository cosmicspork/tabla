/**
 * The pair-mailbox Durable Object.
 *
 * One instance per mailbox, addressed by `idFromName(mailboxId)`. It holds
 * sealed invitations for a recipient who will come looking, and knows nothing
 * else: not who left them, not who they are for, not what game they describe.
 *
 * The id is the only credential there is. It is derived from a secret that only
 * the two people involved can compute, so it cannot be guessed, enumerated, or
 * linked to a public key — which is what makes a signature pointless here.
 * Anyone who could produce a valid one is already someone who could find the
 * mailbox. See ARCHITECTURE, "Inviting a contact".
 */
import { DurableObject } from 'cloudflare:workers';

import {
  ErrorCode,
  INVITE_TTL_MS,
  MAILBOX_MAX_PENDING,
  toBase64Url,
  type PushSubscriptionJson,
} from '@tabla/shared';

import type { Env } from './env.ts';
import { sendPush } from './push.ts';

export interface StoredMessage {
  messageId: string;
  body: string;
  createdAt: number;
}

export interface PostResult {
  ok: boolean;
  messageId?: string;
  expiresAt?: number;
  code?: string;
}

export class MailboxDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS message (
          message_id TEXT PRIMARY KEY,
          body       BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        )
      `);
    });
  }

  /**
   * Leaves a sealed invitation, and nudges the recipient if they are listening.
   *
   * The relay picks the message id for the same reason it picks a blob id: so
   * that one caller cannot overwrite another's message by choosing the same
   * name for it.
   */
  async post(body: string, now: number): Promise<PostResult> {
    this.expire(now);

    const [{ count }] = this.ctx.storage.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM message`)
      .toArray();

    if (count >= MAILBOX_MAX_PENDING) return { ok: false, code: ErrorCode.MailboxFull };

    const messageId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const expiresAt = now + INVITE_TTL_MS;

    this.ctx.storage.sql.exec(
      `INSERT INTO message (message_id, body, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      messageId,
      body,
      now,
      expiresAt,
    );

    await this.scheduleExpiry();
    await this.notify();

    return { ok: true, messageId, expiresAt };
  }

  /** Everything waiting, oldest first. */
  async list(now: number): Promise<StoredMessage[]> {
    this.expire(now);

    return this.ctx.storage.sql
      .exec<{ message_id: string; body: string; created_at: number }>(
        `SELECT message_id, body, created_at FROM message ORDER BY created_at ASC`,
      )
      .toArray()
      .map((row) => ({
        messageId: row.message_id,
        body: row.body,
        createdAt: row.created_at,
      }));
  }

  /**
   * Drops a message the recipient has taken.
   *
   * Deleted after it has been stored on the device rather than as it is read,
   * so a client that dies mid-request gets it again rather than losing it.
   */
  async remove(messageId: string): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM message WHERE message_id = ?`, messageId);
  }

  /** Where to send a nudge when something arrives. */
  async setPush(subscription: PushSubscriptionJson | null): Promise<void> {
    if (subscription === null) {
      this.ctx.storage.sql.exec(`DELETE FROM meta WHERE k = 'push_sub'`);
      return;
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('push_sub', ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      JSON.stringify(subscription),
    );
  }

  /** Unread invitations expire on the same schedule as the invites they name. */
  async alarm(): Promise<void> {
    this.expire(Date.now());
    await this.scheduleExpiry();
  }

  private expire(now: number): void {
    this.ctx.storage.sql.exec(`DELETE FROM message WHERE expires_at <= ?`, now);
  }

  private async scheduleExpiry(): Promise<void> {
    const [next] = this.ctx.storage.sql
      .exec<{ at: number | null }>(`SELECT MIN(expires_at) AS at FROM message`)
      .toArray();

    if (next?.at) await this.ctx.storage.setAlarm(next.at);
    else await this.ctx.storage.deleteAlarm();
  }

  /**
   * Tells the recipient something is here, if they left a way to be told.
   *
   * The payload names the mailbox and nothing else — an opaque id, to a device
   * that already knows what it means.
   */
  private async notify(): Promise<void> {
    const [row] = this.ctx.storage.sql
      .exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'push_sub'`)
      .toArray();

    if (!row) return;

    const subscription = JSON.parse(row.v) as PushSubscriptionJson;
    const outcome = await sendPush(this.env, subscription, { mailbox: this.mailboxId() });

    // A dead endpoint is dropped rather than retried forever.
    if (outcome.expired) await this.setPush(null);
  }

  /**
   * This mailbox's own id.
   *
   * A DO cannot read the name it was addressed by, so it is written down the
   * first time it is needed — by `post`, which is the only caller that has to
   * say which mailbox it is talking about.
   */
  private mailboxId(): string {
    const [row] = this.ctx.storage.sql
      .exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'id'`)
      .toArray();
    return row?.v ?? '';
  }

  /** Told to the object once, by the route that resolved it. */
  async remember(mailboxId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('id', ?) ON CONFLICT(k) DO NOTHING`,
      mailboxId,
    );
  }
}
