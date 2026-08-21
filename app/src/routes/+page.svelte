<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import StatusBanner from '$lib/components/StatusBanner.svelte';
  import { catchUp } from '$lib/catch-up.ts';
  import { listContacts, listGames } from '$lib/db/store.ts';
  import type { GameRecord, InboxRecord } from '$lib/db/schema.ts';
  import { cancelPendingGame, refreshPendingGame } from '$lib/games.ts';
  import { groupGames, type Group } from '$lib/game-list.ts';
  import { pollDevices } from '$lib/devices.ts';
  import { acceptInvite, declineInvite, inbox, pollInbox } from '$lib/mailbox.ts';
  import { onShouldResync } from '$lib/lifecycle.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { titleOf } from '$lib/registry.ts';

  let groups = $state<Group[]>([]);
  let invitations = $state<InboxRecord[]>([]);
  let names = $state<Record<string, string>>({});
  let acting = $state<string | null>(null);
  let loaded = $state(false);
  let showFinished = $state(false);
  let failure = $state<string | null>(null);
  /** Non-null only while a freshly linked device is fetching its logs. */
  let catching = $state<{ done: number; total: number } | null>(null);

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

    names = Object.fromEntries(
      (await listContacts()).map((contact) => [contact.publicKey, contact.name]),
    );

    // What is already on this device first, so the list is right immediately;
    // then ask the relay, which is a network round trip nobody should wait on.
    invitations = await inbox();
    await pollInbox().catch(() => []);
    invitations = await inbox();

    // Anything this person's other devices have done since we last looked: a
    // game started on a phone, an invitation withdrawn, a contact renamed.
    if ((await pollDevices().catch(() => 0)) > 0) {
      groups = await groupGames(await listGames());
      names = Object.fromEntries(
        (await listContacts()).map((contact) => [contact.publicKey, contact.name]),
      );
    }
  }

  /**
   * Fills in a device that has just been linked.
   *
   * The list appears immediately with whatever the bundle carried, and the
   * logs arrive underneath it one game at a time — the alternative is a
   * spinner in front of a device that has everything except the moves.
   */
  async function fillIn() {
    catching = { done: 0, total: 0 };
    await catchUp((progress) => (catching = progress));
    catching = null;
    await refresh();
  }

  async function accept(item: InboxRecord) {
    acting = item.messageId;
    failure = null;
    try {
      const result = await acceptInvite(item.messageId);
      if (result.ok) await goto(`/g/${encodeURIComponent(result.game.gameId)}`);
      else {
        failure = 'That invitation could not be opened. It may already have been taken back.';
        await refresh();
      }
    } finally {
      acting = null;
    }
  }

  async function decline(item: InboxRecord) {
    await declineInvite(item.messageId);
    await refresh();
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

  // A device that has just been linked arrives with every game listed and most
  // of the logs missing. `?linked=1` is how `/link` says so.
  $effect(() => {
    if (page.url.searchParams.get('linked') === null) return;
    void goto('/', { replaceState: true, noScroll: true, keepFocus: true });
    void fillIn();
  });

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
  const empty = $derived(loaded && groups.length === 0 && invitations.length === 0);
</script>

{#if failure}
  <p class="notice warn">{failure}</p>
{/if}

<div class="stack">
  {#if catching}
    <StatusBanner
      text="Catching up"
      detail={catching.total > 0 ? `${catching.done} of ${catching.total} games` : ''}
      spinner
    />
  {/if}

  <a class="primary start" href="/new">Start a new game</a>

  {#if invitations.length > 0}
    <section>
      <h2 class="group">
        <span>Invitations</span>
        <span class="count">{invitations.length}</span>
      </h2>
      <ul>
        {#each invitations as item (item.messageId)}
          <li class="card invite" data-invitation={item.messageId}>
            <span class="line">
              <span class="title">
                {titleOf(item.pluginId)} with {names[item.fromPubKey] ?? 'someone you have played'}
              </span>
            </span>
            <span class="muted detail">They started a game and are waiting for you.</span>
            <span class="row">
              <button class="primary" onclick={() => accept(item)} disabled={acting !== null}>
                {acting === item.messageId ? 'Opening…' : 'Play'}
              </button>
              <button onclick={() => decline(item)} disabled={acting !== null}>No thanks</button>
            </span>
          </li>
        {/each}
      </ul>
    </section>
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

  .invite {
    display: grid;
    gap: 0.4rem;
  }

  .past {
    margin-top: 1rem;
  }

  /* A link, styled as the button it replaces: starting a game is a page now,
     because choosing who to play is the first half of it. */
  .start {
    display: block;
    padding: 0.55rem 0.95rem;
    /* `button.primary` cannot reach an anchor, and an anchor is what this is
       now that starting a game is a page. */
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    text-align: center;
    text-decoration: none;
    color: #fff;
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
