<script lang="ts">
  import { listContacts } from '$lib/db/store.ts';
  import type { ContactRecord } from '$lib/db/schema.ts';
  import { fingerprint, myPublicKey } from '$lib/identity.ts';

  let publicKey = $state('');
  let contacts = $state<ContactRecord[]>([]);

  $effect(() => {
    void (async () => {
      publicKey = await myPublicKey();
      contacts = await listContacts();
    })();
  });
</script>

<h1>Settings</h1>

<div class="stack">
  <section class="card">
    <h2>This device</h2>
    <p class="muted">
      Your identity key was generated here and has never left. There is no account, no email, and
      nothing to look you up by.
    </p>
    <p class="mono key">{publicKey}</p>
  </section>

  <section class="card">
    <h2>People you have played</h2>
    {#if contacts.length === 0}
      <p class="muted">Nobody yet. Contacts are saved after a game's first handshake.</p>
    {:else}
      <ul>
        {#each contacts as contact (contact.publicKey)}
          <li>
            <span>{contact.name}</span>
            <span class="mono muted">{fingerprint(contact.publicKey)}…</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .key {
    word-break: break-all;
    font-size: 0.75rem;
    color: var(--fg-muted);
    margin: 0;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.4rem;
  }

  li {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
</style>
