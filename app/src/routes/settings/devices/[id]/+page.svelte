<script lang="ts">
  /** One device: what it is called, what it has been doing, and how to stop it. */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import { getDevice } from '$lib/db/store.ts';
  import type { DeviceRecord } from '$lib/db/schema.ts';
  import { removeDevice, renameDevice } from '$lib/devices.ts';
  import { relativeTime } from '$lib/game-list.ts';
  import { MAX_NAME_LENGTH } from '$lib/profile.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';

  let device = $state<DeviceRecord | null>(null);
  let name = $state('');
  let saved = $state(false);
  let busy = $state(false);

  $effect(() => {
    void (async () => {
      const found = await getDevice(page.params.id ?? '');
      device = found ?? null;
      name = found?.name ?? '';
      pageTitle.text = found?.name ?? 'Device';
    })();
  });

  async function save() {
    if (!device) return;
    await renameDevice(device.id, name);
    saved = true;
    setTimeout(() => (saved = false), 2000);
  }

  async function remove() {
    if (!device) return;
    const confirmed = confirm(
      `Remove ${device.name}? It will stop being able to play your games from the next move on.`,
    );
    if (!confirmed) return;

    busy = true;
    try {
      await removeDevice(device.id);
      await goto('/settings/devices');
    } finally {
      busy = false;
    }
  }
</script>

<div class="stack">
  {#if device}
    <section class="card">
      <div class="kv">
        <span class="muted">Linked</span><span>{new Date(device.linkedAt).toLocaleString()}</span>
      </div>
      <div class="kv">
        <span class="muted">Last heard from</span>
        <span>{device.lastSeenAt ? relativeTime(device.lastSeenAt) : 'Not yet'}</span>
      </div>
    </section>

    <section class="card stack">
      <label>
        <span class="muted">Name</span>
        <input bind:value={name} maxlength={MAX_NAME_LENGTH} data-testid="device-name" />
      </label>
      <p class="muted small">Only you see this. It is how you tell your devices apart here.</p>
      <div class="row">
        <button onclick={save}>Save name</button>
        {#if saved}<span class="muted" data-testid="device-saved">Saved.</span>{/if}
      </div>
    </section>

    <section class="card stack">
      <h2>Remove this device</h2>
      <p class="muted">
        It stops being able to play your games from the next move on. Your games, the people you
        play, and your fingerprint stay exactly as they are on your other devices.
      </p>
      <div>
        <button class="danger" onclick={remove} disabled={busy} data-testid="remove-device">
          Remove {device.name}
        </button>
      </div>
    </section>
  {:else}
    <p class="muted">That device is not on this list.</p>
  {/if}
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

  .kv {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.4rem 0;
    font-size: 0.9rem;
  }

  .kv + .kv {
    border-top: 1px solid var(--border);
  }
</style>
