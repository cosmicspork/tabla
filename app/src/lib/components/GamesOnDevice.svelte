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
  import { allGames } from '$lib/registry.ts';

  // Every version this build carries, not just the current one: an older
  // version's files are on the device too, and are the ones a game in progress
  // is using.
  const games = allGames().filter((entry) => entry.distribution === 'downloadable');

  const keyOf = (entry: { id: string; version: number }) => `${entry.id}@${entry.version}`;

  /** The newest version of each game, so older ones can be marked as such. */
  const current = games.reduce((newest, entry) => {
    newest.set(entry.id, Math.max(newest.get(entry.id) ?? 0, entry.version));
    return newest;
  }, new Map<string, number>());

  /**
   * Two versions of one game are two downloads under one name, which is
   * unreadable without saying which is which. Only the superseded ones are
   * labelled: the current version is just the game.
   */
  const supersededBy = (entry: { id: string; version: number }) =>
    (current.get(entry.id) ?? entry.version) > entry.version
      ? `version ${entry.version}`
      : null;

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
        next[keyOf(entry)] = await installedState(entry.id, entry.version);
      } catch {
        // A manifest this build will not trust: say nothing here, because the
        // game itself will explain properly when someone tries to open it.
      }
    }
    states = next;
  }

  async function act(
    entry: { id: string; version: number },
    action: (id: string, version: number) => Promise<void>,
  ) {
    busy = keyOf(entry);
    failure = null;
    try {
      await action(entry.id, entry.version);
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
    {#each games as entry (keyOf(entry))}
      {@const state = states[keyOf(entry)]}
      <li data-plugin={entry.id} data-version={entry.version}>
        <div>
          <span>
            {entry.title}
            {#if supersededBy(entry)}
              <span class="muted older">{supersededBy(entry)}</span>
            {/if}
          </span>
          <span class="muted size" data-size={state?.storedBytes ?? 0}>
            {#if state?.installed}
              {megabytes(state.storedBytes)} on this device
            {:else if state && supersededBy(entry)}
              only for games that started under it
            {:else if state}
              not downloaded — {megabytes(state.totalBytes)}
            {:else}
              unavailable
            {/if}
          </span>
        </div>

        {#if state?.installed}
          <button disabled={busy === keyOf(entry)} onclick={() => act(entry, removePlugin)}>
            Remove
          </button>
        {:else if state && !supersededBy(entry)}
          <button disabled={busy === keyOf(entry)} onclick={() => act(entry, installPlugin)}>
            {busy === keyOf(entry) ? 'Downloading…' : 'Download'}
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

  .older {
    font-size: 0.8rem;
  }
</style>
