/**
 * Main-thread client for the plugin sandbox.
 *
 * Turns the worker's message protocol into ordinary awaited calls. Every method
 * here is careful to pass only game data — never a key, never a game id, never
 * anything that would tell the plugin who is playing.
 */
import type { PluginRequest, PluginResponse, PluginResult, PluginView } from './protocol.ts';

/**
 * `Omit` over a union keeps only the keys every member shares, which would drop
 * every operation's own fields. Distributing over the union preserves them.
 */
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never;

type Pending = {
  resolve: (result: PluginResult | undefined) => void;
  reject: (error: Error) => void;
};

export class PluginHost {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<PluginResponse>) => {
      const { id, ok, result, error } = event.data;
      const pending = this.pending.get(id);
      if (!pending) return;

      this.pending.delete(id);
      if (ok) pending.resolve(result);
      else pending.reject(new Error(error ?? 'plugin failed'));
    });

    worker.addEventListener('error', (event) => {
      const failure = new Error(event.message || 'plugin worker crashed');
      for (const pending of this.pending.values()) pending.reject(failure);
      this.pending.clear();
    });

    this.worker = worker;
    return worker;
  }

  private call(request: WithoutId<PluginRequest>): Promise<PluginResult | undefined> {
    const id = this.nextId++;
    const worker = this.ensureWorker();

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...request, id } as PluginRequest);
    });
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
  }): Promise<void> {
    await this.call({ op: 'validate', ...options });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

let shared: PluginHost | null = null;

/** One sandbox for the whole app; games take turns using it. */
export function pluginHost(): PluginHost {
  shared ??= new PluginHost();
  return shared;
}
