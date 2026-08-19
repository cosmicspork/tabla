<script lang="ts">
  import { renderSVG } from 'uqr';

  let { link }: { link: string } = $props();

  let copied = $state(false);

  // Rendered locally; the QR never leaves the device, key and all.
  const qr = $derived(renderSVG(link, { border: 2 }));

  async function copy() {
    await navigator.clipboard.writeText(link);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  async function share() {
    if (navigator.share) await navigator.share({ text: link });
    else await copy();
  }
</script>

<div class="card stack" data-invite-link={link}>
  <div>
    <h2>Invite someone</h2>
    <p class="muted">
      This link works once. Whoever opens it first becomes your opponent, and every later attempt
      is refused.
    </p>
  </div>

  <div class="qr">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- uqr emits a static SVG -->
    {@html qr}
  </div>

  <div class="row">
    <button class="primary" onclick={share}>
      {copied ? 'Copied' : 'Share link'}
    </button>
    <button onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
  </div>

  <p class="muted small">
    The part of the link after <code>#</code> is the key. Browsers never send it to a server, so the
    relay stores an invite it cannot read.
  </p>
</div>

<style>
  .qr {
    display: grid;
    place-items: center;
    padding: 0.75rem;
    background: #fff;
    border-radius: var(--radius);
  }

  .qr :global(svg) {
    width: min(13rem, 60vw);
    height: auto;
  }

  .small {
    font-size: 0.8rem;
    margin: 0;
  }
</style>
