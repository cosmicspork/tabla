<script lang="ts">
  /**
   * Offering this installation to another device.
   *
   * The words are the whole of it: they are the key the bundle is sealed under
   * and the name of the place it is left. So they are shown large, they are
   * never sent anywhere, and they stop being shown the moment the other device
   * has been.
   */
  import { onDestroy } from 'svelte';
  import { renderSVG } from 'uqr';

  import StatusBanner from '$lib/components/StatusBanner.svelte';
  import { offerLink, timeLeft, watchLink, withdrawLink } from '$lib/link.ts';
  import type { Offer } from '$lib/link.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';

  let offer = $state<Offer | null>(null);
  let phase = $state<'opening' | 'waiting' | 'taken' | 'gone' | 'failed'>('opening');
  let failure = $state('');
  let now = $state(Date.now());

  let poll: ReturnType<typeof setInterval> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  $effect(() => {
    pageTitle.text = 'Link a new device';
  });

  $effect(() => {
    void (async () => {
      try {
        offer = await offerLink();
        phase = 'waiting';
        poll = setInterval(check, 3000);
        tick = setInterval(() => (now = Date.now()), 1000);
      } catch (error) {
        phase = 'failed';
        failure = error instanceof Error ? error.message : String(error);
      }
    })();
  });

  onDestroy(() => {
    clearInterval(poll);
    clearInterval(tick);
  });

  async function check() {
    if (!offer) return;
    const next = await watchLink(offer.linkId);
    if (next === 'waiting') return;

    phase = next;
    clearInterval(poll);
    clearInterval(tick);
  }

  async function cancel() {
    if (!offer) return;
    await withdrawLink(offer.linkId, offer.cancelToken);
    phase = 'gone';
    clearInterval(poll);
    clearInterval(tick);
  }

  const qr = $derived(
    offer ? renderSVG(`${location.origin}/link#${offer.words.join('-')}`, { border: 2 }) : '',
  );
  const left = $derived(offer ? timeLeft(offer.expiresAt, now) : '');
</script>

<div class="stack">
  {#if phase === 'opening'}
    <StatusBanner text="Getting this device ready" spinner />
  {:else if phase === 'failed'}
    <StatusBanner text={failure} tone="warn" />
  {:else if phase === 'taken'}
    <StatusBanner text="Linked." />
    <p class="muted">
      Your other device has everything and is catching up. It will appear in the list once it says
      hello.
    </p>
    <a class="primary start" href="/settings/devices">Back to devices</a>
  {:else if phase === 'gone'}
    <StatusBanner text="That link is closed." tone="warn" />
    <a class="primary start" href="/settings/devices/link">Start another</a>
  {:else if offer}
    <p class="muted">
      On the other device, open tabla and choose <b>I already play on another device</b>. Then scan
      this, or read out the words.
    </p>

    <section class="card code">
      <div class="qr" aria-hidden="true">{@html qr}</div>
      <p class="words" data-testid="link-words" data-words={offer.words.join(' ')}>
        {#each offer.words as word, index (index)}<span>{word}</span>{/each}
      </p>
    </section>

    <StatusBanner text="Waiting for the other device" detail="{left} left" spinner />

    {#if offer.omittedGames > 0}
      <p class="muted small">
        {offer.omittedGames} older
        {offer.omittedGames === 1 ? 'game is' : 'games are'} too big to send this way. They will be on
        the list, and fill themselves in when opened.
      </p>
    {/if}

    <div>
      <button onclick={cancel}>Cancel</button>
    </div>

    <p class="muted small">The words are the key. This link works once, then expires.</p>
  {/if}
</div>

<style>
  .code {
    display: grid;
    justify-items: center;
    gap: 0.75rem;
  }

  .qr {
    width: 10rem;
    max-width: 100%;
  }

  .qr :global(svg) {
    display: block;
    width: 100%;
    height: auto;
    background: #fff;
    padding: 0.35rem;
    border-radius: 0.4rem;
  }

  .words {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.35rem 0.75rem;
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 1.05rem;
    letter-spacing: 0.02em;
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
