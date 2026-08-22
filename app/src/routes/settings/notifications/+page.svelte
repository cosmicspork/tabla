<script lang="ts">
  /**
   * Whether this device gets told when it is your turn.
   *
   * The states here are not a toggle plus an error line: "your browser cannot",
   * "iOS needs the app installed first", "you said no once" and "off" are
   * different situations with different next steps, and only one of them is a
   * switch. So the page is a ladder, and each rung says what to do about it.
   */
  import { isIos } from '$lib/lifecycle.ts';
  import { registerInboxPush } from '$lib/mailbox.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import {
    disablePush,
    enablePush,
    pushAvailability,
    pushPreference,
    type PushAvailability,
  } from '$lib/push.ts';

  let availability = $state<PushAvailability | null>(null);
  let asked = $state(false);
  let busy = $state(false);

  $effect(() => {
    pageTitle.text = 'Notifications';
  });

  $effect(() => {
    void refresh();
  });

  async function refresh() {
    availability = await pushAvailability();
    asked = await pushPreference();
  }

  async function turnOn() {
    busy = true;
    try {
      const subscription = await enablePush();
      // Every mailbox this device watches, as well as the games it is in: an
      // invitation arrives in one and a move in the other.
      if (subscription) await registerInboxPush(subscription).catch(() => {});
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function turnOff() {
    busy = true;
    try {
      await disablePush();
      await refresh();
    } finally {
      busy = false;
    }
  }
</script>

<div class="stack">
  <section class="card stack">
    <div>
      <h2>When it is your turn</h2>
      <p class="muted">
        A notification says only that your opponent has played, never what. Each device chooses for
        itself.
      </p>
    </div>

    {#if availability === 'enabled'}
      <p class="notice" data-testid="push-state">On for this device.</p>
      <div>
        <button onclick={turnOff} disabled={busy}>
          {busy ? 'Turning off…' : 'Turn off notifications'}
        </button>
      </div>
    {:else if availability === 'available'}
      <p class="muted" data-testid="push-state">
        {asked ? 'Off for this device.' : 'Not set up on this device.'}
      </p>
      <div>
        <button class="primary" onclick={turnOn} disabled={busy}>
          {busy ? 'Asking…' : 'Turn on notifications'}
        </button>
      </div>
    {:else if availability === 'needs-install'}
      <p class="muted" data-testid="push-state">
        On iPhone and iPad, notifications work only once an app has been added to the Home Screen.
      </p>
      <ol>
        <li>Tap the Share button in Safari's toolbar.</li>
        <li>Choose <strong>Add to Home Screen</strong>.</li>
        <li>Open tabla from your Home Screen, then come back here.</li>
      </ol>
    {:else if availability === 'denied'}
      <p class="muted" data-testid="push-state">
        Notifications are blocked for this site. {isIos()
          ? 'You can change that in Settings › Notifications.'
          : "You can change that in your browser's site settings."}
      </p>
    {:else if availability === 'unsupported'}
      <p class="muted" data-testid="push-state">
        This browser cannot receive them. Games work the same either way — you just have to come and
        look.
      </p>
    {:else}
      <p class="muted" data-testid="push-state">Checking…</p>
    {/if}
  </section>
</div>

<style>
  ol {
    margin: 0;
    padding-left: 1.2rem;
    color: var(--fg-muted);
    font-size: 0.9rem;
    display: grid;
    gap: 0.3rem;
  }
</style>
