<script lang="ts">
  import { goto } from '$app/navigation';

  import { listGames } from '$lib/db/store.ts';
  import type { GameRecord } from '$lib/db/schema.ts';
  import { cancelPendingGame, createGame, refreshPendingGame } from '$lib/games.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { availableGames, titleOf } from '$lib/registry.ts';

  let games = $state<GameRecord[]>([]);
  let creating = $state<string | null>(null);
  let picking = $state(false);
  let failure = $state<string | null>(null);

  // Home is the one screen with no page title: the header shows the wordmark.
  $effect(() => {
    pageTitle.text = '';
  });

  async function refresh() {
    games = await listGames();

    // Pending invites may have been redeemed since we last looked.
    const pending = games.filter((game) => game.status === 'pending');
    if (pending.length > 0) {
      await Promise.all(pending.map((game) => refreshPendingGame(game.gameId).catch(() => {})));
      games = await listGames();
    }
  }

  $effect(() => {
    void refresh();
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

  function label(game: GameRecord): string {
    if (game.status === 'pending') return 'Waiting for someone to join';
    if (game.status === 'expired') return 'Nobody took this invite';
    if (game.status === 'incompatible') return 'Needs a newer version of tabla';
    if (game.status === 'finished') return game.outcome ?? 'Finished';
    return game.role === 'initiator' ? 'You started this one' : 'They invited you';
  }
</script>

<h2 class="screen-title">Your games</h2>

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

  {#if games.length === 0}
    <div class="card">
      <h2>Nothing here yet</h2>
      <p class="muted">
        Start a game and send someone the link. The link works once, and the key that unlocks it
        travels in the part of the URL your browser never sends to a server.
      </p>
    </div>
  {:else}
    <ul>
      {#each games as game (game.gameId)}
        <li>
          <a class="card game" href="/g/{encodeURIComponent(game.gameId)}">
            <span class="title">{titleOf(game.pluginId)}</span>
            <span class="muted">{label(game)}</span>
          </a>
          {#if game.status === 'pending' || game.status === 'expired'}
            <button class="ghost cancel" onclick={() => cancel(game)}>
              {game.status === 'expired' ? 'Remove' : 'Cancel invite'}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* The header owns the only `h1`, so the list heading is an `h2` that looks
     like the page title it used to be. */
  .screen-title {
    font-size: 1.5rem;
    letter-spacing: -0.02em;
    margin: 0 0 0.75rem;
  }

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

  .game {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    text-decoration: none;
    color: inherit;
  }

  .game:hover {
    border-color: var(--accent);
  }

  .title {
    font-weight: 550;
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
