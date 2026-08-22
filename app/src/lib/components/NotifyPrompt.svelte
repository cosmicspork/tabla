<script lang="ts">
  /**
   * Offers notifications, or explains what has to happen first.
   *
   * Shown only once a real game exists — asking before there is anything to be
   * notified about is how a person ends up saying no permanently.
   */
  import { isIos } from '$lib/lifecycle.ts';
  import { registerInboxPush } from '$lib/mailbox.ts';
  import { enablePush, pushAvailability, type PushAvailability } from '$lib/push.ts';
  import type { PushSubscriptionJson } from '@tabla/shared';

  let { onsubscribe }: { onsubscribe: (subscription: PushSubscriptionJson) => void } = $props();

  let availability = $state<PushAvailability | null>(null);
  let busy = $state(false);

  $effect(() => {
    void pushAvailability().then((next) => (availability = next));
  });

  async function turnOn() {
    busy = true;
    try {
      const subscription = await enablePush();
      if (subscription) {
        onsubscribe(subscription);
        // Turns are not the only thing worth being told about: an invitation
        // from someone you have played lands in a mailbox, not a game room.
        void registerInboxPush(subscription);
        availability = 'enabled';
      } else {
        availability = await pushAvailability();
      }
    } finally {
      busy = false;
    }
  }
</script>

{#if availability === 'available'}
  <div class="card stack">
    <div>
      <h2>Get told when it is your turn</h2>
      <p class="muted">Notifications say only that your opponent has played, never what.</p>
    </div>
    <div>
      <button class="primary" onclick={turnOn} disabled={busy}>
        {busy ? 'Asking…' : 'Turn on notifications'}
      </button>
    </div>
  </div>
{:else if availability === 'needs-install'}
  <div class="card stack">
    <div>
      <h2>Add tabla to your Home Screen</h2>
      <p class="muted">
        On iPhone and iPad, notifications work only once an app has been added to the Home Screen.
      </p>
    </div>
    <ol>
      <li>Tap the Share button in Safari's toolbar.</li>
      <li>Choose <strong>Add to Home Screen</strong>.</li>
      <li>Open tabla from your Home Screen, then come back here.</li>
    </ol>
  </div>
{:else if availability === 'denied'}
  <p class="muted">
    Notifications are blocked for this site. {isIos()
      ? 'You can change that in Settings › Notifications.'
      : "You can change that in your browser's site settings."}
  </p>
{/if}

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
