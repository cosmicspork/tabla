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
  import { displayName, MAX_NAME_LENGTH, setDisplayName } from '$lib/profile.ts';

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
    await setDisplayName(name);
    saved = true;
    setTimeout(() => (saved = false), 2000);
  }
</script>

<div class="stack">
  <section class="card stack">
    <div>
      <h2>Your name</h2>
      <p class="muted">
        Shown to the people you play, so a game can be called “Letras with Pooja”. It travels sealed
        inside the invite and the game's own log — never to the relay.
      </p>
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
    <p class="muted small">
      Not a login and not unique: two people can pick the same one, nothing checks it, and whoever
      you play can rename you on their own device. The fingerprint below is the part that identifies
      you.
    </p>
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
      Read it to a friend to be sure you are playing them and not someone who got hold of the link.
      Nobody can look you up by it, and there is nothing else to give out.
    </p>
    {#if showingFull}
      <p class="mono full" data-testid="full-key">{key}</p>
    {:else}
      <div>
        <button onclick={() => (showingFull = true)}>Show the whole key</button>
      </div>
    {/if}
  </section>

  <section class="card">
    <h2>One device at a time</h2>
    <p class="muted">
      Your identity lives on this phone and nowhere else. To play from a different one, make a
      backup and restore it there — that moves the identity across. Playing as the same person from
      two devices at once would split every shared game in half, so it is a move rather than a
      merge.
    </p>
  </section>
</div>

<style>
  label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.85rem;
  }

  .small {
    font-size: 0.8rem;
    margin: 0;
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
