/**
 * What the sandbox asks for, and what the host sends it.
 *
 * Nothing reaches the worker by its own effort: it has no network, so the rules
 * for a game it does not carry and the word list those rules read both have to
 * be handed in. A word list is several hundred kilobytes and the position is
 * recomputed on every render, so neither is copied into each request — the
 * worker is asked first and told only what it turns out to be missing.
 *
 * These tests drive the host against a stand-in worker that speaks the same
 * message protocol, because the behaviour worth checking is that negotiation.
 */
import { describe, expect, it } from 'vitest';

import { PluginHost, type WorkerLike } from './host.ts';
import {
  ASSET_MISSING,
  MODULE_MISSING,
  type PluginRequest,
  type PluginResponse,
} from './protocol.ts';

/**
 * A worker that answers `view` only once it holds both the game's rules and the
 * asset the request names — the state a genuinely cold worker is in.
 */
class FakeWorker implements WorkerLike {
  private handlers: ((response: PluginResponse) => void)[] = [];
  readonly held = new Map<string, Uint8Array>();
  readonly seen: PluginRequest[] = [];

  /** Games this worker can play without being given anything. */
  constructor(private readonly bundled: string[] = ['letras']) {}

  private readonly loaded = new Set<string>();

  postMessage(message: unknown): void {
    const request = message as PluginRequest;
    this.seen.push(request);

    if (request.op === 'provideAsset') {
      this.held.set(request.hash, request.bytes);
      return this.reply({ id: request.id, ok: true, result: { kind: 'ok' } });
    }

    if (request.op === 'provideModule') {
      this.loaded.add(request.pluginId);
      return this.reply({ id: request.id, ok: true, result: { kind: 'ok' } });
    }

    if (request.op === 'view') {
      const pluginId = request.pluginId;
      if (!this.bundled.includes(pluginId) && !this.loaded.has(pluginId)) {
        return this.reply({ id: request.id, ok: false, error: MODULE_MISSING });
      }
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

  protected reply(response: PluginResponse): void {
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
    pluginVersion: 1,
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

describe('providing rules to the sandbox', () => {
  /** A worker that bundles only tic tac toe, as the shipped one does. */
  function coldWorker() {
    return new FakeWorker(['tictactoe']);
  }

  const MODULE = new Uint8Array(2048).fill(3);

  it('supplies a module the worker lacks and retries the request', async () => {
    const worker = coldWorker();
    const host = new PluginHost(() => worker);
    host.useModuleSource(async () => MODULE);

    await host.view(viewRequest());

    expect(worker.seen.map((r) => r.op)).toEqual(['view', 'provideModule', 'view']);
  });

  it('supplies rules and then the data they read, in one call', async () => {
    // The order matters and is not arbitrary: a worker cannot say what word
    // list it needs until it has the rules that read one. This is the state
    // every first game on a fresh device starts in.
    const worker = coldWorker();
    const host = new PluginHost(() => worker);
    host.useModuleSource(async () => MODULE);
    host.useAssetSource(async () => DICTIONARY);

    const result = await host.view(viewRequest('abc123'));

    expect(result.view.bytes).toBe(1024);
    expect(worker.seen.map((r) => r.op)).toEqual([
      'view',
      'provideModule',
      'view',
      'provideAsset',
      'view',
    ]);
  });

  it('sends the rules once, however many games follow', async () => {
    const worker = coldWorker();
    const host = new PluginHost(() => worker);

    let fetched = 0;
    host.useModuleSource(async () => {
      fetched += 1;
      return MODULE;
    });

    await host.view(viewRequest());
    await host.view(viewRequest());

    expect(fetched).toBe(1);
    expect(worker.seen.filter((r) => r.op === 'provideModule')).toHaveLength(1);
  });

  it('gives up rather than looping when the worker keeps asking', async () => {
    // A worker that reported a module missing after being given one would
    // otherwise spin forever. Each thing is supplied at most once per call.
    const worker = new (class extends FakeWorker {
      override postMessage(message: unknown): void {
        const request = message as PluginRequest;
        this.seen.push(request);

        if (request.op === 'provideModule') {
          return this.reply({ id: request.id, ok: true, result: { kind: 'ok' } });
        }
        this.reply({ id: request.id, ok: false, error: MODULE_MISSING });
      }
    })();

    const host = new PluginHost(() => worker);
    host.useModuleSource(async () => MODULE);

    await expect(host.view(viewRequest())).rejects.toThrow(MODULE_MISSING);
    expect(worker.seen.filter((r) => r.op === 'provideModule')).toHaveLength(1);
  });

  it('passes the failure through when no source has been registered', async () => {
    const worker = coldWorker();
    const host = new PluginHost(() => worker);

    await expect(host.view(viewRequest())).rejects.toThrow(MODULE_MISSING);
  });

  it('does not go looking for a game the worker already has', async () => {
    const worker = new FakeWorker(['letras']);
    const host = new PluginHost(() => worker);
    host.useModuleSource(async () => {
      throw new Error('should not be asked');
    });

    await host.view(viewRequest());

    expect(worker.seen.map((r) => r.op)).toEqual(['view']);
  });
});
