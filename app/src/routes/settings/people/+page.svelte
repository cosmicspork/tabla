<script lang="ts">
  /**
   * The people this device has played, and what to call them.
   *
   * Names here are a label you choose, not an identity anyone claimed: the
   * fingerprint is the only thing that identifies a player, and it is shown
   * beside every name so the two are never confused.
   */
  import { listContacts, listGames, renameContact } from '$lib/db/store.ts';
  import type { ContactRecord, GameRecord } from '$lib/db/schema.ts';
  import { fingerprint } from '$lib/identity.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';

  let contacts = $state<ContactRecord[]>([]);
  let games = $state<GameRecord[]>([]);
  let editing = $state<string | null>(null);
  let draft = $state('');

  $effect(() => {
    pageTitle.text = 'People';
  });

  $effect(() => {
    void refresh();
  });

  async function refresh() {
    contacts = await listContacts();
    games = await listGames();
  }

  function start(contact: ContactRecord) {
    editing = contact.publicKey;
    draft = contact.name;
  }

  async function save(contact: ContactRecord) {
    const name = draft.trim();
    if (name.length > 0 && name !== contact.name) await renameContact(contact.publicKey, name);
    editing = null;
    await refresh();
  }

  /** No index links contacts to games, and at these sizes none is worth adding. */
  function playedWith(contact: ContactRecord): number {
    return games.filter(
      (game) =>
        game.initiatorPubKey === contact.publicKey || game.claimerPubKey === contact.publicKey,
    ).length;
  }

  function describe(contact: ContactRecord): string {
    const count = playedWith(contact);
    const played = count === 1 ? '1 game' : `${count} games`;
    return `${played} · met ${new Date(contact.firstSeen).toLocaleDateString()}`;
  }
</script>

{#if contacts.length === 0}
  <div class="card">
    <h2>Nobody yet</h2>
    <p class="muted">People are added here as soon as someone opens one of your invites.</p>
  </div>
{:else}
  <ul class="stack">
    {#each contacts as contact (contact.publicKey)}
      <li class="card stack" data-contact={contact.publicKey}>
        {#if editing === contact.publicKey}
          <label>
            <span class="muted">Name</span>
            <input
              bind:value={draft}
              maxlength="32"
              autocomplete="off"
              onkeydown={(event) => {
                if (event.key === 'Enter') void save(contact);
                if (event.key === 'Escape') editing = null;
              }}
            />
          </label>
          <div class="row">
            <button class="primary" onclick={() => save(contact)}>Save</button>
            <button onclick={() => (editing = null)}>Cancel</button>
          </div>
        {:else}
          <div class="setting">
            <span class="label">
              <b>{contact.name}</b>
              <small>{describe(contact)}</small>
            </span>
            <button onclick={() => start(contact)}>Rename</button>
          </div>
        {/if}
        <p class="mono print">{fingerprint(contact.publicKey)}…</p>
      </li>
    {/each}
  </ul>
{/if}

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.85rem;
  }

  .print {
    font-size: 0.8rem;
    color: var(--fg-muted);
    margin: 0;
  }
</style>
