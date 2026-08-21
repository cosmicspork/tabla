<script lang="ts">
  /**
   * The devices this person plays from.
   *
   * All of them are the same player as far as an opponent or the relay is
   * concerned, so nothing here is an account or a session — it is a list of
   * machines and a way to tell one to stop.
   */
  import { listDevices } from '$lib/db/store.ts';
  import type { DeviceRecord } from '$lib/db/schema.ts';
  import { pollDevices, thisDevice } from '$lib/devices.ts';
  import { relativeTime } from '$lib/game-list.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';

  let devices = $state<DeviceRecord[]>([]);
  let mine = $state('');

  $effect(() => {
    pageTitle.text = 'Devices';
  });

  $effect(() => {
    void (async () => {
      mine = (await thisDevice()).id;
      devices = await listDevices();

      // Opening this page is the moment somebody wants to know whether the
      // device they just linked has said hello, so ask rather than wait for
      // the next visit to the game list.
      if ((await pollDevices().catch(() => 0)) > 0) devices = await listDevices();
    })();
  });

  function subtitle(device: DeviceRecord): string {
    const linked = `Linked ${new Date(device.linkedAt).toLocaleDateString()}`;
    return device.lastSeenAt ? `${linked} · active ${relativeTime(device.lastSeenAt)}` : linked;
  }
</script>

<div class="stack">
  <div class="hub">
    {#each devices as device (device.id)}
      {#if device.id === mine}
        <div class="row" data-device={device.id}>
          <span class="text">
            <b>{device.name} <span class="pill">This one</span></b>
            <span>{subtitle(device)}</span>
          </span>
        </div>
      {:else}
        <a class="hub-row" href="/settings/devices/{device.id}" data-device={device.id}>
          <span class="text">
            <b>{device.name}</b>
            <span>{subtitle(device)}</span>
          </span>
          <svg class="chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </a>
      {/if}
    {/each}
  </div>

  <a class="primary start" href="/settings/devices/link" data-testid="link-device">
    Link a new device
  </a>

  <p class="muted">
    Every device plays as you, with your name and your fingerprint. Nobody you play sees more than
    one person, and the relay cannot tell which of them is which.
  </p>

  <section class="card">
    <h2>When a device is lost</h2>
    <p class="muted">
      Open it above and choose Remove. It stops being able to play your games from the next move on.
      It keeps whatever it had already downloaded, so if it was stolen rather than mislaid, start
      again with a new identity instead.
    </p>
  </section>
</div>

<style>
  .hub {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .row,
  .hub :global(.hub-row) {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.7rem 0.85rem;
    border-bottom: 1px solid var(--border);
  }

  .row:last-child,
  .hub :global(.hub-row:last-child) {
    border-bottom: none;
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  .text b {
    display: block;
    font-weight: 550;
  }

  .text > span {
    display: block;
    font-size: 0.8rem;
    color: var(--fg-muted);
  }

  .pill {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1em 0.5em;
    border-radius: 1em;
    background: var(--accent-soft);
    color: var(--accent);
    vertical-align: 0.1em;
  }

  .chevron {
    stroke: var(--fg-muted);
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
  }

  .start {
    display: block;
    text-align: center;
    text-decoration: none;
    background: var(--accent);
  }
</style>
