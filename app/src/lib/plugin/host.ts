/**
 * Main-thread client for the plugin sandbox.
 *
 * Turns the worker's message protocol into ordinary awaited calls. Every method
 * here is careful to pass only game data — never a key, never a game id, never
 * anything that would tell the plugin who is playing.
 */
import {
  ASSET_MISSING,
  type PluginRequest,
  type PluginResponse,
  type PluginResult,
  type PluginView,
} from './protocol.ts';

/**
 * Supplies the bytes for a hash the worker is missing.
 *
 * Registered by the app rather than called directly so that this module keeps
 * no opinion about where reference data comes from — and, more to the point, so
 * the sandbox's own inability to fetch stays the only fetching story.
 */
export type AssetSource = (hash: string) => Promise<Uint8Array>;

/**
 * `Omit` over a union keeps only the keys every member shares, which would drop
 * every operation's own fields. Distributing over the union preserves them.
 */
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never;

type Pending = {
  resolve: (result: PluginResult | undefined) => void;
  reject: (error: Error) => void;
};

/**
 * What this host needs from a sandbox, stated in its own terms rather than the
 * DOM's, so a test can stand one in without a browser.
 *
 * The sandbox guarantees come from what the real worker deletes at startup and
 * from what is never sent to it — not from this type — so substituting it in a
 * test weakens nothing.
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  onMessage(handler: (response: PluginResponse) => void): void;
  onError(handler: (message: string) => void): void;
  terminate(): void;
}

function spawnWorker(): WorkerLike {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  });

  return {
    postMessage: (message) => worker.postMessage(message),
    onMessage: (handler) =>
      worker.addEventListener('message', (event: MessageEvent<PluginResponse>) =>
        handler(event.data),
      ),
    onError: (handler) => worker.addEventListener('error', (event) => handler(event.message)),
    terminate: () => worker.terminate(),
  };
}

export class PluginHost {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private assetSource: AssetSource | null = null;

  constructor(private readonly spawn: () => WorkerLike = spawnWorker) {}

  /** Tells the host where to find reference data a game asks for. */
  useAssetSource(source: AssetSource): void {
    this.assetSource = source;
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;

    const worker = this.spawn();
    worker.onMessage(({ id, ok, result, error }) => {
      const pending = this.pending.get(id);
      if (!pending) return;

      this.pending.delete(id);
      if (ok) pending.resolve(result);
      else pending.reject(new Error(error ?? 'plugin failed'));
    });

    worker.onError((message) => {
      const failure = new Error(message || 'plugin worker crashed');
      for (const pending of this.pending.values()) pending.reject(failure);
      this.pending.clear();
    });

    this.worker = worker;
    return worker;
  }

  private post(request: WithoutId<PluginRequest>): Promise<PluginResult | undefined> {
    const id = this.nextId++;
    const worker = this.ensureWorker();

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...request, id } as PluginRequest);
    });
  }

  /**
   * Sends a request, supplying reference data on demand.
   *
   * The worker is asked first and only told what it turns out to be missing.
   * That keeps the common case — every render after the first — free of a
   * multi-hundred-kilobyte copy, and means a worker that was restarted refills
   * itself without anyone tracking its lifetime.
   */
  private async call(request: WithoutId<PluginRequest>): Promise<PluginResult | undefined> {
    try {
      return await this.post(request);
    } catch (error) {
      const hash = 'assetHash' in request ? request.assetHash : undefined;
      if (!isAssetMissing(error) || hash === undefined || !this.assetSource) throw error;

      const bytes = await this.assetSource(hash);
      await this.post({ op: 'provideAsset', hash, bytes });

      return await this.post(request);
    }
  }

  async availablePlugins(): Promise<string[]> {
    const result = await this.call({ op: 'availablePlugins' });
    return result?.kind === 'strings' ? result.value : [];
  }

  async pluginVersion(pluginId: string): Promise<number> {
    const result = await this.call({ op: 'pluginVersion', pluginId });
    if (result?.kind !== 'number') throw new Error('unexpected plugin response');
    return result.value;
  }

  /**
   * Encodes a move the way this game's rules define.
   *
   * The UI describes moves in its own terms; the plugin owns the bytes, because
   * those bytes get signed into the log and an encoding mismatch would be
   * unrecoverable.
   */
  async encodeMove(pluginId: string, move: unknown): Promise<Uint8Array> {
    const result = await this.call({
      op: 'encodeMove',
      pluginId,
      json: JSON.stringify(move),
    });
    if (result?.kind !== 'bytes') throw new Error('unexpected plugin response');
    return result.value;
  }

  /** Replays the move list and renders it from one player's point of view. */
  async view(options: {
    pluginId: string;
    config: Uint8Array;
    seed: Uint8Array;
    moves: Uint8Array[];
    player: number;
    assetHash?: string;
  }): Promise<PluginView> {
    const result = await this.call({ op: 'view', ...options });
    if (result?.kind !== 'view') throw new Error('unexpected plugin response');
    return result.value;
  }

  /** Checks a move before it is signed, so illegal moves never enter the log. */
  async validate(options: {
    pluginId: string;
    config: Uint8Array;
    seed: Uint8Array;
    moves: Uint8Array[];
    move: Uint8Array;
    player: number;
    assetHash?: string;
  }): Promise<void> {
    await this.call({ op: 'validate', ...options });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

function isAssetMissing(error: unknown): boolean {
  return error instanceof Error && error.message === ASSET_MISSING;
}

let shared: PluginHost | null = null;

/** One sandbox for the whole app; games take turns using it. */
export function pluginHost(): PluginHost {
  shared ??= new PluginHost();
  return shared;
}
