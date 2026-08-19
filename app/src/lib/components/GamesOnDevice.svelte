<script lang="ts">
  /**
   * Which downloadable games this device is holding, and how to be rid of them.
   *
   * Removing one is deliberately unalarming: nothing about a game in progress
   * is stored here — logs and keys live elsewhere — so the worst a removal can
   * cost is the download again next time.
   */
  import {
    installPlugin,
    installedState,
    removePlugin,
    type InstalledState,
  } from '$lib/plugin/install.ts';
  import { availableGames } from '$lib/registry.ts';

  const games = availableGames().filter((entry) => entry.distribution === 'downloadable');

  let states = $state<Record<string, InstalledState>>({});
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  $effect(() => {
    void refresh();
  });

  async function refresh() {
    const next: Record<string, InstalledState> = {};
    for (const entry of games) {
      try {
        next[entry.id] = await installedState(entry.id);
      } catch {
        // A manifest this build will not trust: say nothing here, because the
        // game itself will explain properly when someone tries to open it.
      }
    }
    states = next;
  }

  async function act(pluginId: string, action: (id: string) => Promise<void>) {
    busy = pluginId;
    failure = null;
    try {
      await action(pluginId);
      await refresh();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = null;
    }
  }

  function megabytes(bytes: number): string {
    return `${Math.round(bytes / 100_000) / 10} MB`;
  }
</script>

<section class="card">
  <h2>Games on this device</h2>
  <p class="muted">
    Games other than tic tac toe are downloaded the first time you play one, and checked against a
    signature before they run. Removing one is safe: it comes back the next time you open a game
    that needs it.
  </p>

  {#if failure}
    <p class="notice warn">{failure}</p>
  {/if}

  <ul>
    {#each games as entry (entry.id)}
      {@const state = states[entry.id]}
      <li data-plugin={entry.id}>
        <div>
          <span>{entry.title}</span>
          <span class="muted size" data-size={state?.storedBytes ?? 0}>
            {#if state?.installed}
              {megabytes(state.storedBytes)} on this device
            {:else if state}
              not downloaded — {megabytes(state.totalBytes)}
            {:else}
              unavailable
            {/if}
          </span>
        </div>

        {#if state?.installed}
          <button disabled={busy === entry.id} onclick={() => act(entry.id, removePlugin)}>
            Remove
          </button>
        {:else if state}
          <button disabled={busy === entry.id} onclick={() => act(entry.id, installPlugin)}>
            {busy === entry.id ? 'Downloading…' : 'Download'}
          </button>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.6rem;
  }

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  li div {
    display: grid;
  }

  .size {
    font-size: 0.85rem;
  }
</style>
