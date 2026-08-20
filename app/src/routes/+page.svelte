<script lang="ts">
  import { goto } from '$app/navigation';

  import { listGames } from '$lib/db/store.ts';
  import type { GameRecord } from '$lib/db/schema.ts';
  import { cancelPendingGame, createGame, refreshPendingGame } from '$lib/games.ts';
  import { groupGames, type Group } from '$lib/game-list.ts';
  import { onShouldResync } from '$lib/lifecycle.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { availableGames } from '$lib/registry.ts';

  let groups = $state<Group[]>([]);
  let loaded = $state(false);
  let creating = $state<string | null>(null);
  let picking = $state(false);
  let showFinished = $state(false);
  let failure = $state<string | null>(null);

  // Home is the one screen with no page title: the header shows the wordmark.
  $effect(() => {
    pageTitle.text = '';
  });

  async function refresh() {
    let games = await listGames();

    // Pending invites may have been redeemed since we last looked.
    const pending = games.filter((game) => game.status === 'pending');
    if (pending.length > 0) {
      await Promise.all(pending.map((game) => refreshPendingGame(game.gameId).catch(() => {})));
      games = await listGames();
    }

    groups = await groupGames(games);
    loaded = true;
  }

  $effect(() => {
    void refresh();

    // Re-read on the moments the answer can have changed: coming back to the
    // app, regaining a network, being woken by a push.
    //
    // This refreshes what *this device* knows, which for an active game is
    // whatever it learned the last time that game was open. Making the list
    // itself current would mean a socket per game just to draw it, and sync
    // deliberately happens on opening a game and on push instead. The
    // consequence is honest but worth knowing: a game can be your move for a
    // while before the list says so, and the push is what tells you.
    return onShouldResync(() => {
      void refresh();
    });
  });

  async function newGame(pluginId: string) {
    creating = pluginId;
    failure = null;
    try {
      const { game } = await createGame(location.origin, pluginId);
      await goto(`/g/${encodeURIComponent(game.gameId)}`);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      creating = null;
      picking = false;
    }
  }

  async function cancel(game: GameRecord) {
    if (!confirm('Call off this invite? The link will stop working for whoever has it.')) return;
    failure = null;
    try {
      await cancelPendingGame(game.gameId);
      await refresh();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  const finished = $derived(groups.find((group) => group.key === 'finished'));
  const active = $derived(groups.filter((group) => group.key !== 'finished'));
  const empty = $derived(loaded && groups.length === 0);
</script>

{#if failure}
  <p class="notice warn">{failure}</p>
{/if}

<div class="stack">
  {#if picking}
    <div class="card picker">
      <h2>What would you like to play?</h2>
      {#each availableGames() as entry (entry.id)}
        <button
          class="choice"
          onclick={() => newGame(entry.id)}
          disabled={creating !== null}
          data-game={entry.id}
        >
          <span class="title">{entry.title}</span>
          <span class="muted">{creating === entry.id ? 'Creating…' : entry.blurb}</span>
        </button>
      {/each}
      <button class="ghost" onclick={() => (picking = false)} disabled={creating !== null}>
        Cancel
      </button>
    </div>
  {:else}
    <button class="primary" onclick={() => (picking = true)}>Start a new game</button>
  {/if}

  {#if empty}
    <div class="card">
      <h2>Nothing here yet</h2>
      <p class="muted">
        Start a game and send someone the link. The link works once, and the key that unlocks it
        travels in the part of the URL your browser never sends to a server.
      </p>
    </div>
  {/if}

  {#each active as group (group.key)}
    <section>
      <h2 class="group">
        <span>{group.title}</span>
        <span class="count">{group.games.length}</span>
      </h2>
      <ul>
        {#each group.games as listed (listed.game.gameId)}
          <li>
            <a class="card game" href="/g/{encodeURIComponent(listed.game.gameId)}">
              <span class="line">
                <span class="title">{listed.title}</span>
                <span class="muted when">{listed.when}</span>
              </span>
              <span class="muted detail">{listed.detail}</span>
            </a>
            {#if listed.cancellable}
              <button class="ghost cancel" onclick={() => cancel(listed.game)}>
                {listed.game.status === 'expired' ? 'Remove' : 'Cancel invite'}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  {#if finished}
    <section class="past">
      <button class="group as-button" onclick={() => (showFinished = !showFinished)}>
        <span>Finished</span>
        <span class="count">{finished.games.length}{showFinished ? '' : ' ›'}</span>
      </button>
      {#if showFinished}
        <ul>
          {#each finished.games as listed (listed.game.gameId)}
            <li>
              <a class="card game" href="/g/{encodeURIComponent(listed.game.gameId)}">
                <span class="line">
                  <span class="title">{listed.title}</span>
                  <span class="muted when">{listed.when}</span>
                </span>
                <span class="muted detail">{listed.detail}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }

  li {
    display: grid;
    gap: 0.15rem;
  }

  /* A section heading, not a page heading: the header owns the only `h1`, and
     these are labels for a list rather than titles for a screen. */
  .group {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: 0 0 0.4rem;
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  .as-button {
    width: 100%;
    border: none;
    background: none;
    padding: 0;
    text-align: left;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  .count {
    font-variant-numeric: tabular-nums;
  }

  .game {
    display: grid;
    gap: 0.15rem;
    text-decoration: none;
    color: inherit;
  }

  .game:hover {
    border-color: var(--accent);
  }

  .line {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .title {
    font-weight: 550;
  }

  .when {
    font-size: 0.8rem;
    flex: none;
  }

  .detail {
    font-size: 0.9rem;
  }

  .past {
    margin-top: 1rem;
  }

  .picker {
    display: grid;
    gap: 0.5rem;
  }

  .choice {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    text-align: left;
    width: 100%;
  }

  .ghost {
    background: none;
    border: none;
    color: var(--fg-muted);
    font-size: 0.9rem;
    padding: 0.25rem;
  }

  .cancel {
    justify-self: start;
  }
</style>
