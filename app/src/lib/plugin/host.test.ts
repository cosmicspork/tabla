/**
 * The asset side of the sandbox boundary.
 *
 * A word list is several hundred kilobytes, and the position is recomputed from
 * scratch on every render — so sending the data with each request would copy it
 * dozens of times per game. It is sent once and referenced by hash instead.
 *
 * These tests drive the host against a stand-in worker that speaks the same
 * message protocol, because the behaviour worth checking is the negotiation:
 * ask first, supply only what turns out to be missing, and never fetch twice.
 */
import { describe, expect, it } from 'vitest';

import { PluginHost, type WorkerLike } from './host.ts';
import { ASSET_MISSING, type PluginRequest, type PluginResponse } from './protocol.ts';

/** A worker that answers `view` only once it has been given the named asset. */
class FakeWorker implements WorkerLike {
  private handlers: ((response: PluginResponse) => void)[] = [];
  readonly held = new Map<string, Uint8Array>();
  readonly seen: PluginRequest[] = [];

  postMessage(message: unknown): void {
    const request = message as PluginRequest;
    this.seen.push(request);

    if (request.op === 'provideAsset') {
      this.held.set(request.hash, request.bytes);
      return this.reply({ id: request.id, ok: true, result: { kind: 'ok' } });
    }

    if (request.op === 'view') {
      if (request.assetHash !== undefined && !this.held.has(request.assetHash)) {
        return this.reply({ id: request.id, ok: false, error: ASSET_MISSING });
      }
      return this.reply({
        id: request.id,
        ok: true,
        result: {
          kind: 'view',
          value: {
            view: {
              bytes: this.held.get(request.assetHash ?? '')?.length ?? 0,
            },
            outcome: null,
          },
        },
      });
    }

    this.reply({
      id: request.id,
      ok: false,
      error: `unexpected op: ${request.op}`,
    });
  }

  private reply(response: PluginResponse): void {
    // Asynchronous, like a real worker: the host must not depend on the answer
    // arriving before `postMessage` returns.
    queueMicrotask(() => {
      for (const handler of this.handlers) handler(response);
    });
  }

  onMessage(handler: (response: PluginResponse) => void): void {
    this.handlers.push(handler);
  }

  onError(): void {
    // Nothing here crashes the way a real worker can.
  }

  terminate(): void {
    this.handlers = [];
  }
}

const DICTIONARY = new Uint8Array(1024).fill(7);

function viewRequest(assetHash?: string) {
  return {
    pluginId: 'letras',
    config: new Uint8Array(),
    seed: new Uint8Array(32),
    moves: [],
    player: 0,
    assetHash,
  };
}

describe('providing reference data to the sandbox', () => {
  it('supplies data the worker is missing and retries the request', async () => {
    const worker = new FakeWorker();
    const host = new PluginHost(() => worker);
    host.useAssetSource(async () => DICTIONARY);

    const result = await host.view(viewRequest('abc123'));

    expect(result.view.bytes).toBe(1024);
    expect(worker.seen.map((r) => r.op)).toEqual(['view', 'provideAsset', 'view']);
  });

  it('sends the data once, however many renders follow', async () => {
    const worker = new FakeWorker();
    const host = new PluginHost(() => worker);

    let fetched = 0;
    host.useAssetSource(async () => {
      fetched += 1;
      return DICTIONARY;
    });

    await host.view(viewRequest('abc123'));
    await host.view(viewRequest('abc123'));
    await host.view(viewRequest('abc123'));

    expect(fetched).toBe(1);
    expect(worker.seen.filter((r) => r.op === 'provideAsset')).toHaveLength(1);
  });

  it('leaves a game that needs no data alone', async () => {
    const worker = new FakeWorker();
    const host = new PluginHost(() => worker);
    host.useAssetSource(async () => {
      throw new Error('should not be asked');
    });

    await host.view(viewRequest());

    expect(worker.seen.map((r) => r.op)).toEqual(['view']);
  });

  it('reports the failure rather than retrying forever when data cannot be found', async () => {
    const worker = new FakeWorker();
    const host = new PluginHost(() => worker);
    host.useAssetSource(async () => {
      throw new Error('offline');
    });

    await expect(host.view(viewRequest('abc123'))).rejects.toThrow(/offline/);
  });

  it('passes the failure through when no source has been registered', async () => {
    const worker = new FakeWorker();
    const host = new PluginHost(() => worker);

    await expect(host.view(viewRequest('abc123'))).rejects.toThrow(ASSET_MISSING);
  });
});
