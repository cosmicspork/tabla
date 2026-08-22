<script lang="ts">
  /**
   * What a device that has been removed sees.
   *
   * It learns this from its own mailbox, not from the relay, and the honest
   * position is that it is being asked to stop rather than made to: it still
   * holds the identity, because every device does. So there is no pretence of
   * a lock — two ways forward and a plain sentence about what remains here.
   */
  import { closeDatabase, DB_NAME } from '$lib/db/schema.ts';
  import Mark from './Mark.svelte';

  let { by }: { by: string } = $props();
  let busy = $state(false);

  async function startFresh() {
    const confirmed = confirm(
      'Start again as someone new? The games and contacts on this device are deleted, and the people you play will no longer recognise it as you.',
    );
    if (!confirmed) return;

    busy = true;
    closeDatabase();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    location.href = '/';
  }
</script>

<div class="removed" data-testid="removed">
  <Mark size={56} />

  <div>
    <h1>This device was removed</h1>
    <p class="muted">
      One of your other devices signed it out. Your games and the people you play are still there;
      nothing here can play them any more.
    </p>
  </div>

  <a class="primary start" href="/link">Link it again</a>
  <button onclick={startFresh} disabled={busy}>Start fresh as someone new</button>

  <p class="muted small">
    Removed by {by.slice(0, 6)}… This device keeps whatever it already downloaded, so if it was
    stolen rather than mislaid, start again with a new identity.
  </p>
</div>

<style>
  .removed {
    display: grid;
    gap: 1rem;
    justify-items: center;
    text-align: center;
    padding-top: 3rem;
    max-width: 24rem;
    margin: 0 auto;
  }

  h1 {
    font-size: 1.5rem;
    margin: 0 0 0.5rem;
  }

  .start,
  button {
    width: 100%;
  }

  .start {
    display: block;
    text-align: center;
    text-decoration: none;
    background: var(--accent);
  }

  .small {
    font-size: 0.8rem;
  }
</style>
