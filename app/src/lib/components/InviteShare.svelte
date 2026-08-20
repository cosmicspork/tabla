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
    <h2>Send this to someone</h2>
    <p class="muted">It works once. Whoever opens it first is your opponent.</p>
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

  <details class="muted small">
    <summary>Why the link is safe to send</summary>
    <p>
      The part after <code>#</code> is the key that unlocks the invite. Browsers never send that part
      to a server, so the relay is holding something it cannot read — and the QR code is drawn here, on
      your device, key and all.
    </p>
  </details>
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

  .small summary {
    cursor: pointer;
  }

  .small p {
    margin: 0.5rem 0 0;
  }
</style>
