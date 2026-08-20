import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { INVITE_TTL_MS } from '@tabla/shared';

import { call, fakeClaim, inviteStub, postJson, randomBase64Url } from './helpers.ts';

async function createInvite(blob = randomBase64Url(120)) {
  const response = await postJson('/api/invite', { blob });
  expect(response.status).toBe(201);
  return {
    blob,
    ...(await response.json<{ blobId: string; expiresAt: number; cancelToken: string }>()),
  };
}

describe('creating an invite', () => {
  it('stores the sealed blob and returns an id the client did not choose', async () => {
    const { blobId, expiresAt } = await createInvite();

    // The relay picks the id so a client cannot squat on or overwrite one.
    expect(blobId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + INVITE_TTL_MS);
  });

  it('rejects a malformed body', async () => {
    expect((await postJson('/api/invite', { nope: true })).status).toBe(400);
    expect((await postJson('/api/invite', { blob: 'not base64url!' })).status).toBe(400);
  });

  it('gives every invite a distinct id', async () => {
    const a = await createInvite();
    const b = await createInvite();

    expect(a.blobId).not.toBe(b.blobId);
  });
});

describe('cancelling an invite', () => {
  it('withdraws it, so the link stops working', async () => {
    const { blobId, cancelToken } = await createInvite();

    const cancelled = await postJson(`/api/invite/${blobId}/cancel`, { cancelToken });
    expect(cancelled.status).toBe(200);

    // Gone for the initiator polling it, and gone for anyone holding the link.
    expect((await call(`/api/invite/${blobId}`)).status).toBe(404);
    expect((await postJson(`/api/invite/${blobId}/claim`, fakeClaim())).status).toBe(404);
  });

  it('clears the expiry alarm it no longer needs', async () => {
    const { blobId, cancelToken } = await createInvite();
    await postJson(`/api/invite/${blobId}/cancel`, { cancelToken });

    // Nothing left to expire: the alarm was deleted with the row.
    expect(await runDurableObjectAlarm(inviteStub(blobId))).toBe(false);
  });

  it('refuses the wrong token, and does not destroy the invite trying', async () => {
    const { blobId } = await createInvite();

    const refused = await postJson(`/api/invite/${blobId}/cancel`, {
      cancelToken: randomBase64Url(16),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'forbidden' });

    // Still there, still claimable.
    expect((await call(`/api/invite/${blobId}`)).status).toBe(200);
  });

  it('refuses to cancel a claimed invite', async () => {
    const { blobId, cancelToken } = await createInvite();
    await postJson(`/api/invite/${blobId}/claim`, fakeClaim());

    // By now it is a game with two players in it. Resigning ends that, not this.
    const refused = await postJson(`/api/invite/${blobId}/cancel`, { cancelToken });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'already_claimed' });
  });

  it('never hands the token back out', async () => {
    const { blobId } = await createInvite();

    const status = await (await call(`/api/invite/${blobId}`)).json();
    expect(status).not.toHaveProperty('cancelToken');
  });
});

describe('claiming an invite', () => {
  it('returns the blob to the first claimer', async () => {
    const { blobId, blob } = await createInvite();

    const response = await postJson(`/api/invite/${blobId}/claim`, fakeClaim());
    expect(response.status).toBe(200);
    expect((await response.json<{ blob: string }>()).blob).toBe(blob);
  });

  it('refuses every claim after the first', async () => {
    const { blobId } = await createInvite();

    expect((await postJson(`/api/invite/${blobId}/claim`, fakeClaim())).status).toBe(200);

    // This is the single-use property the whole invite design rests on.
    const second = await postJson(`/api/invite/${blobId}/claim`, fakeClaim());
    expect(second.status).toBe(409);
    expect((await second.json<{ code: string }>()).code).toBe('already_claimed');

    const third = await postJson(`/api/invite/${blobId}/claim`, fakeClaim());
    expect(third.status).toBe(409);
  });

  it('holds only one winner when claims arrive together', async () => {
    const { blobId } = await createInvite();

    // A Durable Object runs single-threaded, so these serialize — but the test
    // exists so that stops being an accident if the storage layer ever changes.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => postJson(`/api/invite/${blobId}/claim`, fakeClaim())),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('records the claimer so the initiator can verify them', async () => {
    const { blobId } = await createInvite();
    const claim = fakeClaim();

    await postJson(`/api/invite/${blobId}/claim`, claim);

    const status = await (await call(`/api/invite/${blobId}`)).json<{
      claimed: boolean;
      claimerPubKey: string;
      sig: string;
    }>();

    expect(status.claimed).toBe(true);
    expect(status.claimerPubKey).toBe(claim.claimerPubKey);
    // Stored, never checked here: the relay is not trusted to authenticate.
    expect(status.sig).toBe(claim.sig);
  });

  it('reports an unclaimed invite as unclaimed', async () => {
    const { blobId } = await createInvite();

    const status = await (await call(`/api/invite/${blobId}`)).json<{ claimed: boolean }>();
    expect(status.claimed).toBe(false);
  });

  it('404s for an invite that never existed', async () => {
    expect((await call(`/api/invite/${randomBase64Url(16)}`)).status).toBe(404);
    expect((await postJson(`/api/invite/${randomBase64Url(16)}/claim`, fakeClaim())).status).toBe(
      404,
    );
  });

  it('rejects a claim body that is not a key and signature', async () => {
    const { blobId } = await createInvite();

    expect((await postJson(`/api/invite/${blobId}/claim`, {})).status).toBe(400);
    expect(
      (await postJson(`/api/invite/${blobId}/claim`, { claimerPubKey: 'short', sig: 'short' }))
        .status,
    ).toBe(400);
  });
});

describe('invite expiry', () => {
  it('is scheduled when the invite is created', async () => {
    const { blobId, expiresAt } = await createInvite();

    await runInDurableObject(inviteStub(blobId), async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(expiresAt);
    });
  });

  it('deletes the invite when the alarm fires', async () => {
    const { blobId } = await createInvite();

    expect(await runDurableObjectAlarm(inviteStub(blobId))).toBe(true);

    expect((await call(`/api/invite/${blobId}`)).status).toBe(404);
    expect((await postJson(`/api/invite/${blobId}/claim`, fakeClaim())).status).toBe(404);
  });

  it('refuses a claim that arrives after the expiry time', async () => {
    const { blobId } = await createInvite();

    // Claim with a clock far past the expiry, without waiting seven days.
    const result = await inviteStub(blobId).claim(
      randomBase64Url(32),
      randomBase64Url(64),
      Date.now() + INVITE_TTL_MS + 1,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('expired');
  });
});
