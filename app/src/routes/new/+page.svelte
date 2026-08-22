<script lang="ts">
  /**
   * Starting a game: who first, then what.
   *
   * The old picker asked only which game, and then handed over a link with no
   * idea who it was for — which is why there was no way to play someone again
   * without digging out a chat thread. Asking who first is what makes a rematch
   * a rematch, and it names the game the moment it is created rather than after
   * the handshake.
   *
   * Choosing a contact does not yet deliver the invite for you; it addresses
   * it. The link still has to be sent, and the screen says so.
   */
  import { goto } from '$app/navigation';

  import { listContacts } from '$lib/db/store.ts';
  import type { ContactRecord } from '$lib/db/schema.ts';
  import { createGame } from '$lib/games.ts';
  import { inviteContact } from '$lib/mailbox.ts';
  import { fingerprint } from '$lib/identity.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { availableGames } from '$lib/registry.ts';

  let contacts = $state<ContactRecord[]>([]);
  /** `null` means someone new, which is the only option on a first game. */
  let opponent = $state<ContactRecord | null>(null);
  let chosen = $state<string | null>(null);
  let creating = $state(false);
  let failure = $state<string | null>(null);

  $effect(() => {
    pageTitle.text = 'Start a game';
  });

  $effect(() => {
    void listContacts().then((all) => {
      contacts = all;
    });
  });

  async function start() {
    if (!chosen) return;
    creating = true;
    failure = null;
    try {
      // Someone we have played can be invited where only they will find it.
      // Someone new can only be reached by a link, which is what a link is for.
      const gameId = opponent
        ? (await inviteContact(location.origin, opponent, chosen)).gameId
        : (await createGame(location.origin, chosen)).game.gameId;

      await goto(`/g/${encodeURIComponent(gameId)}`);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      creating = false;
    }
  }

  const label = $derived(opponent ? `Invite ${opponent.name}` : 'Make an invite link');
</script>

{#if failure}
  <p class="notice warn">{failure}</p>
{/if}

<div class="stack">
  {#if contacts.length > 0}
    <section>
      <h2 class="group">Who with</h2>
      <div class="opts">
        {#each contacts as contact (contact.publicKey)}
          <button
            class="opt"
            class:sel={opponent?.publicKey === contact.publicKey}
            onclick={() => (opponent = contact)}
            data-contact={contact.publicKey}
          >
            <span class="avatar" aria-hidden="true">{contact.name.slice(0, 1).toUpperCase()}</span>
            <span class="text">
              <b>{contact.name}</b>
              <span class="muted">{fingerprint(contact.publicKey)}…</span>
            </span>
          </button>
        {/each}
        <button class="opt" class:sel={opponent === null} onclick={() => (opponent = null)}>
          <span class="avatar new" aria-hidden="true">+</span>
          <span class="text">
            <b>Someone new</b>
            <span class="muted">You will get a link to send them</span>
          </span>
        </button>
      </div>
    </section>
  {/if}

  <section>
    <h2 class="group">Which game</h2>
    <div class="opts">
      {#each availableGames() as entry (entry.id)}
        <button
          class="opt"
          class:sel={chosen === entry.id}
          onclick={() => (chosen = entry.id)}
          data-game={entry.id}
        >
          <span class="text">
            <b>{entry.title}</b>
            <span class="muted">{entry.blurb}</span>
          </span>
        </button>
      {/each}
    </div>
  </section>

  <div class="row actions">
    <button onclick={() => history.back()} disabled={creating}>Cancel</button>
    <button class="primary" onclick={start} disabled={!chosen || creating}>
      {creating ? 'Creating…' : label}
    </button>
  </div>

  {#if opponent}
    <p class="muted note">
      {opponent.name} will find this waiting the next time they open tabla. Nothing is sent to anybody.
    </p>
  {/if}
</div>

<style>
  .group {
    margin: 0 0 0.4rem;
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  .opts {
    display: grid;
    gap: 0.5rem;
  }

  .opt {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.7rem 0.85rem;
    text-align: left;
  }

  .opt.sel {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .text {
    display: grid;
    min-width: 0;
  }

  .text b {
    font-weight: 550;
  }

  .text .muted {
    font-size: 0.8rem;
  }

  .avatar {
    display: grid;
    place-items: center;
    flex: none;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  .avatar.new {
    background: var(--bg);
    border: 1px dashed var(--border);
    color: var(--fg-muted);
  }

  .actions {
    margin-top: 0.5rem;
  }

  .actions button {
    flex: 1;
  }

  .note {
    font-size: 0.85rem;
    margin: 0;
  }
</style>
