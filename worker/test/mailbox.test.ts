/**
 * Pair mailboxes, from the relay's side.
 *
 * The relay's whole part in this is holding a sealed blob for whoever asks for
 * it by name — so what is worth testing is that it holds exactly that, bounds
 * what it will hold, forgets on schedule, and learns nothing on the way.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { INVITE_TTL_MS, MAILBOX_MAX_PENDING } from '@tabla/shared';

import { call, mailboxStub, postJson, randomBase64Url } from './helpers.ts';

/** An id shaped exactly like one derived from a pair secret. */
function mailbox() {
  return randomBase64Url(16);
}

async function post(id: string, body = randomBase64Url(200)) {
  const response = await postJson(`/api/mailbox/${id}`, { body });
  return { body, response, ...(await response.json<{ messageId: string; expiresAt: number }>()) };
}

async function poll(ids: string[]) {
  const response = await postJson('/api/mailbox/poll', { ids });
  expect(response.status).toBe(200);
  return (
    await response.json<{
      mailboxes: Record<string, { messageId: string; body: string; createdAt: number }[]>;
    }>()
  ).mailboxes;
}

describe('leaving an invitation', () => {
  it('holds the sealed body for whoever comes looking', async () => {
    const id = mailbox();
    const { body, messageId, expiresAt } = await post(id);

    expect(messageId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + INVITE_TTL_MS);

    // Byte for byte: the relay is a shelf, not a reader.
    expect((await poll([id]))[id]).toEqual([
      expect.objectContaining({ messageId, body }),
    ]);
  });

  it('gives every message an id the writer did not choose', async () => {
    const id = mailbox();
    const first = await post(id);
    const second = await post(id);

    // Otherwise one caller could overwrite another's message by naming it.
    expect(first.messageId).not.toBe(second.messageId);
    expect((await poll([id]))[id]).toHaveLength(2);
  });

  it('refuses to hold more than a mailbox is allowed', async () => {
    const id = mailbox();
    for (let i = 0; i < MAILBOX_MAX_PENDING; i += 1) await post(id);

    // A contact can fill your mailbox; what they cannot do is fill your relay.
    const over = await postJson(`/api/mailbox/${id}`, { body: randomBase64Url(200) });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ code: 'mailbox_full' });
  });

  it('rejects a malformed body', async () => {
    expect((await postJson(`/api/mailbox/${mailbox()}`, { nope: true })).status).toBe(400);
    expect((await postJson(`/api/mailbox/${mailbox()}`, { body: 'not base64!' })).status).toBe(400);
  });
});

describe('reading a mailbox', () => {
  it('reads several at once, and says nothing about the ones with nothing in them', async () => {
    const [a, b, empty] = [mailbox(), mailbox(), mailbox()];
    await post(a);
    await post(b);

    const seen = await poll([a, b, empty]);
    expect(seen[a]).toHaveLength(1);
    expect(seen[b]).toHaveLength(1);
    // An empty mailbox and one that has never existed are the same thing here,
    // which is what stops polling from being a way to ask whether a pair exists.
    expect(seen[empty]).toEqual([]);
  });

  it('refuses to poll more mailboxes than anyone plausibly has', async () => {
    const ids = Array.from({ length: 65 }, mailbox);
    expect((await postJson('/api/mailbox/poll', { ids })).status).toBe(400);
    expect((await postJson('/api/mailbox/poll', { ids: [] })).status).toBe(400);
  });

  it('forgets a message once it has been taken', async () => {
    const id = mailbox();
    const { messageId } = await post(id);

    const deleted = await call(`/api/mailbox/${id}/${messageId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await poll([id]))[id]).toEqual([]);
  });
});

describe('expiry', () => {
  it('drops an unread invitation on the same schedule as the invite it names', async () => {
    const id = mailbox();
    await post(id);

    // Age it past the deadline rather than waiting seven days for it.
    const stub = mailboxStub(id);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE message SET expires_at = ?`, Date.now() - 1);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await poll([id]))[id]).toEqual([]);
  });
});

describe('being told something arrived', () => {
  /**
   * A real P-256 point and auth secret, shared with `push.test.ts`: RFC 8291
   * encryption rejects fabricated curve material, so this has to be genuine
   * even though nobody holds the private half.
   */
  const subscription = {
    endpoint: 'https://push.example/send/mailbox',
    keys: {
      p256dh:
        'BAui2rC6tG7bWdH4Tu1LOBJuQ0Jnakb3SelbAdY2k73Hk4FLw4-4KvT81KZhKqdUQ5YUbpXirKJbJOiT8-quWgI',
      auth: '9ROHgYBT3dvmUnMB8z8miA',
    },
  };

  it('nudges the recipient, saying only which mailbox', async () => {
    const id = mailbox();

    const registered = await call(`/api/mailbox/${id}/push`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription }),
    });
    expect(registered.status).toBe(200);

    // The push itself is intercepted; what matters is that the relay tried, and
    // that everything it could have put in the payload it does not have — it
    // has never seen a name, a game, or a key.
    const { response } = await post(id);
    expect(response.status).toBe(201);

    const stored = await runInDurableObject(mailboxStub(id), async (_instance, state) =>
      state.storage.sql
        .exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'push_sub'`)
        .toArray()
        .at(0),
    );
    expect(stored?.v).toContain('push.example');
  });

  it('rejects a malformed subscription', async () => {
    const refused = await call(`/api/mailbox/${mailbox()}/push`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: { endpoint: 'not a url' } }),
    });
    expect(refused.status).toBe(400);
  });
});
