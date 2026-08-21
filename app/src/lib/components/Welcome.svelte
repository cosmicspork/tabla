<script lang="ts">
  /**
   * First run, and the only screen shown before there is an identity.
   *
   * Two things happen here, and the order matters: the person says what to call
   * them, and *then* an identity is generated on the tap. Generating one on
   * page load meant a fresh install spent its first moments compiling the core
   * module and writing keys before anything had been asked of it — work that
   * belongs behind a deliberate action, where it reads as the app starting up
   * rather than as the phone stalling.
   */
  import Mark from './Mark.svelte';
  import { loadIdentity } from '$lib/identity.ts';
  import { markOnboarded, MAX_NAME_LENGTH, setDisplayName } from '$lib/profile.ts';

  let { onready }: { onready: () => void } = $props();

  let name = $state('');
  let busy = $state(false);
  /**
   * The first screen is a fork, not a form.
   *
   * Asking for a name before asking whether there is anything to link is asking
   * the wrong person: someone with a phone already playing has a name, and
   * would be typing it a second time for a device that is about to be told it.
   */
  let asking = $state(false);

  async function start() {
    busy = true;
    try {
      await setDisplayName(name);
      // The first and only time a key is generated on this device.
      await loadIdentity();
      await markOnboarded();
      onready();
    } finally {
      busy = false;
    }
  }
</script>

<div class="welcome">
  <Mark size={72} />

  <div>
    <h1>Games for two,<br />nobody watching.</h1>
    <p class="muted">
      Play someone you know, a turn at a time. Nothing about your games leaves your two phones in a
      form anybody else can read.
    </p>
  </div>

  {#if !asking}
    <button class="primary" onclick={() => (asking = true)} data-testid="new-here">
      I'm new here
    </button>
    <a class="secondary" href="/link" data-testid="already-play">
      I already play on another device
    </a>
    <a class="muted restore" href="/settings/backup">I have a backup file</a>
  {:else}
    <label>
      <span class="muted">What should friends call you?</span>
      <input
        bind:value={name}
        maxlength={MAX_NAME_LENGTH}
        autocomplete="nickname"
        placeholder="Josh"
        data-testid="display-name"
        onkeydown={(event) => {
          if (event.key === 'Enter') void start();
        }}
      />
      <span class="muted hint">
        Shown to people you play. Not a login, not unique, and you can change it later.
      </span>
    </label>

    <button class="primary" onclick={start} disabled={busy} data-testid="start-playing">
      {busy ? 'Setting up…' : 'Start playing'}
    </button>
  {/if}
</div>

<style>
  .welcome {
    display: grid;
    gap: 1.25rem;
    justify-items: center;
    text-align: center;
    padding-top: 3rem;
    max-width: 24rem;
    margin: 0 auto;
  }

  h1 {
    font-size: 1.75rem;
    line-height: 1.2;
    margin: 0 0 0.5rem;
  }

  label {
    display: grid;
    gap: 0.35rem;
    width: 100%;
    text-align: left;
    font-size: 0.85rem;
  }

  .hint {
    font-size: 0.75rem;
  }

  button {
    width: 100%;
  }

  .restore {
    font-size: 0.85rem;
  }

  .secondary {
    width: 100%;
    display: block;
    text-align: center;
    text-decoration: none;
    padding: 0.6rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font-size: 0.95rem;
  }
</style>
