<script lang="ts">
  /**
   * Who this device is, to the people it plays.
   *
   * There is no account here to manage — the whole of your identity is one
   * keypair that was generated on this device and has never left it. What this
   * page is actually for is the one moment that key matters to a person:
   * checking, out loud, that the person you are playing is the person you think.
   */
  import { fingerprint, myPublicKey } from '$lib/identity.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { changeDisplayName, displayName, MAX_NAME_LENGTH } from '$lib/profile.ts';

  let key = $state('');
  let name = $state('');
  let saved = $state(false);
  let showingFull = $state(false);

  $effect(() => {
    pageTitle.text = 'Profile';
  });

  $effect(() => {
    void (async () => {
      key = await myPublicKey();
      name = await displayName();
    })();
  });

  async function save() {
    await changeDisplayName(name);
    saved = true;
    setTimeout(() => (saved = false), 2000);
  }
</script>

<div class="stack">
  <section class="card stack">
    <div>
      <h2>Your name</h2>
      <p class="muted">Shown to the people you play. It never reaches the relay.</p>
    </div>
    <label>
      <span class="muted">Display name</span>
      <input
        bind:value={name}
        maxlength={MAX_NAME_LENGTH}
        autocomplete="nickname"
        placeholder="Josh"
        data-testid="display-name"
      />
    </label>
    <div class="row">
      <button class="primary" onclick={save}>Save</button>
      {#if saved}<span class="muted" data-testid="name-saved">Saved.</span>{/if}
    </div>
  </section>

  <section class="card stack">
    <div>
      <h2>Your fingerprint</h2>
      <p class="mono print">{fingerprint(key)}…</p>
    </div>
    <p class="muted">
      Read it to a friend to be sure you are playing them, and not someone who got hold of the link.
      It is the same on every device you link.
    </p>
    {#if showingFull}
      <p class="mono full" data-testid="full-key">{key}</p>
    {:else}
      <div>
        <button onclick={() => (showingFull = true)}>Show the whole key</button>
      </div>
    {/if}
  </section>
</div>

<style>
  label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.85rem;
  }

  .print {
    font-size: 1.05rem;
    letter-spacing: 0.04em;
    margin: 0.25rem 0 0;
  }

  .full {
    word-break: break-all;
    font-size: 0.75rem;
    color: var(--fg-muted);
    margin: 0;
  }
</style>
