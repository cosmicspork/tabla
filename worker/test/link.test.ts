/**
 * Handing an identity to another of your own devices.
 *
 * The link is a whole installation sealed under six words, so the properties
 * that matter are all about how briefly it exists and how few times it can be
 * collected: once, within ten minutes, by whoever can name it.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { LINK_TTL_MS } from '@tabla/shared';

import { call, linkStub, postJson, randomBase64Url } from './helpers.ts';

async function offerLink(blob = randomBase64Url(512)) {
  const linkId = randomBase64Url(16);
  const response = await postJson('/api/link', { linkId, blob });
  expect(response.status).toBe(201);

  return {
    linkId,
    blob,
    ...(await response.json<{ expiresAt: number; cancelToken: string }>()),
  };
}

describe('offering a link', () => {
  it('stores the bundle under the id the client derived from its words', async () => {
    // The relay does not choose this id, and could not: it comes from the words
    // shown on the offering device, which are also the passphrase. That is what
    // stops the relay from enumerating what it is holding.
    const { linkId, expiresAt } = await offerLink();

    const status = await call(`/api/link/${linkId}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ taken: false, expiresAt });
  });

  it('expires in minutes, not days', async () => {
    const { expiresAt } = await offerLink();

    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + LINK_TTL_MS);
  });

  it('rejects a malformed body', async () => {
    expect((await postJson('/api/link', { blob: randomBase64Url(8) })).status).toBe(400);
    expect((await postJson('/api/link', { linkId: 'short', blob: 'a' })).status).toBe(400);
    expect((await postJson('/api/link', { linkId: randomBase64Url(16), blob: '!' })).status).toBe(
      400,
    );
  });

  it('refuses to overwrite a link that is still open', async () => {
    const { linkId, blob } = await offerLink();

    const second = await postJson('/api/link', { linkId, blob: randomBase64Url(64) });
    expect(second.status).toBe(409);

    // The original is untouched, which is the point of refusing.
    const taken = await postJson(`/api/link/${linkId}/take`, {});
    expect(await taken.json<{ blob: string }>()).toEqual({ blob });
  });

  it('lets an id be reused once the link it named has expired', async () => {
    const { linkId } = await offerLink();
    await runDurableObjectAlarm(linkStub(linkId));

    expect((await postJson('/api/link', { linkId, blob: randomBase64Url(64) })).status).toBe(201);
  });
});

describe('taking a link', () => {
  it('hands over the bundle exactly once', async () => {
    const { linkId, blob } = await offerLink();

    const first = await postJson(`/api/link/${linkId}/take`, {});
    expect(first.status).toBe(200);
    expect(await first.json<{ blob: string }>()).toEqual({ blob });

    // A second device — or the same one asking twice — gets nothing.
    expect((await postJson(`/api/link/${linkId}/take`, {})).status).toBe(409);
  });

  it('is safe against two devices racing for it', async () => {
    const { linkId } = await offerLink();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => postJson(`/api/link/${linkId}/take`, {})),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('tells the offering device that it was taken', async () => {
    // Which is how the words stop being shown: not a guess about timing, but
    // the relay saying the other device has been and gone.
    const { linkId } = await offerLink();
    await postJson(`/api/link/${linkId}/take`, {});

    const status = await call(`/api/link/${linkId}`);
    expect((await status.json<{ taken: boolean }>()).taken).toBe(true);
  });

  it('is refused after the expiry time', async () => {
    const { linkId } = await offerLink();

    const result = await linkStub(linkId).take(Date.now() + LINK_TTL_MS + 1);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('expired');
  });

  it('is a 404 for a link that never existed', async () => {
    expect((await postJson(`/api/link/${randomBase64Url(16)}/take`, {})).status).toBe(404);
    expect((await call(`/api/link/${randomBase64Url(16)}`)).status).toBe(404);
  });
});

describe('withdrawing a link', () => {
  it('stops it being taken', async () => {
    const { linkId, cancelToken } = await offerLink();

    expect((await postJson(`/api/link/${linkId}/cancel`, { cancelToken })).status).toBe(200);
    expect((await postJson(`/api/link/${linkId}/take`, {})).status).toBe(404);
    expect((await call(`/api/link/${linkId}`)).status).toBe(404);
  });

  it('refuses the wrong token, and survives being asked', async () => {
    const { linkId, blob, cancelToken } = await offerLink();

    expect(
      (await postJson(`/api/link/${linkId}/cancel`, { cancelToken: randomBase64Url(16) })).status,
    ).toBe(403);

    const taken = await postJson(`/api/link/${linkId}/take`, {});
    expect(await taken.json<{ blob: string }>()).toEqual({ blob });

    // And the real token still works afterwards.
    expect((await postJson(`/api/link/${linkId}/cancel`, { cancelToken })).status).toBe(200);
  });

  it('never hands the token back to anyone who asks for status', async () => {
    const { linkId } = await offerLink();

    const body = await (await call(`/api/link/${linkId}`)).text();
    expect(body).not.toContain('cancelToken');
  });

  it('clears the expiry alarm it no longer needs', async () => {
    const { linkId, cancelToken } = await offerLink();
    await postJson(`/api/link/${linkId}/cancel`, { cancelToken });

    expect(await runDurableObjectAlarm(linkStub(linkId))).toBe(false);
  });
});

describe('link expiry', () => {
  it('is scheduled when the link is offered', async () => {
    const { linkId, expiresAt } = await offerLink();

    await runInDurableObject(linkStub(linkId), async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(expiresAt);
    });
  });

  it('deletes the bundle when the alarm fires', async () => {
    const { linkId } = await offerLink();

    expect(await runDurableObjectAlarm(linkStub(linkId))).toBe(true);
    expect((await postJson(`/api/link/${linkId}/take`, {})).status).toBe(404);
  });
});

describe('the shape of the route', () => {
  it('refuses methods it does not offer', async () => {
    const { linkId } = await offerLink();

    expect((await call(`/api/link/${linkId}`, { method: 'DELETE' })).status).toBe(405);
    expect((await call(`/api/link/${linkId}/take`)).status).toBe(405);
  });
});
