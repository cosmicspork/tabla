<script lang="ts">
  /**
   * The screen for a link that landed in the wrong browser.
   *
   * Shown *before* the link is redeemed, never after, because redeeming is what
   * spends it. On iOS a Home Screen app and Safari are separate storage, so a
   * link opened here would start a game — or adopt a whole installation —
   * somewhere the app on the Home Screen cannot reach, and the person would
   * find out days later, when the games were not there and the link was gone.
   *
   * There is no way to hand a URL to an installed web app on iOS, so the last
   * step is the person's: carry it across and paste it. Saying that plainly is
   * better than a button that pretends to do it.
   */
  let {
    kind,
    link = '',
    words = '',
    oncontinue,
  }: {
    kind: 'invite' | 'device';
    /** The whole link, fragment included, for the invite that came as a URL. */
    link?: string;
    /** Six words instead, for a device link: short enough to be typed. */
    words?: string;
    /** For someone who really does play in this browser. */
    oncontinue: () => void;
  } = $props();

  /** What gets carried across, and what the copy button copies. */
  const carry = $derived(kind === 'device' ? words : link);

  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(carry);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard access can be refused outright, which is why what has to be
      // carried is on screen as selectable text and not only behind a button.
      copied = false;
    }
  }
</script>

<div class="card stack">
  <div>
    <h2>Open this in the tabla app</h2>
    <p class="muted">
      {#if kind === 'device'}
        You are in a browser tab. On iPhone and iPad, tabla on the Home Screen keeps its own
        separate games — so a device linked here would not be the one you end up using, and a link
        works only once.
      {:else}
        You are in a browser tab, not the tabla app. On iPhone and iPad the two keep separate games,
        so joining here would start this one under a new identity — and an invite works only once.
      {/if}
    </p>
  </div>

  <ol>
    {#if kind === 'device'}
      <li>
        Open tabla from your Home Screen — or add it there first: Share, then
        <strong>Add to Home Screen</strong>.
      </li>
      <li>Choose <strong>I already play on another device</strong>.</li>
      <li>{words ? 'Type these six words.' : 'Read the six words off your other device.'}</li>
    {:else}
      <li>Copy the link.</li>
      <li>Open tabla from your Home Screen.</li>
      <li>Tap <strong>Open a link someone sent me</strong>, and paste it.</li>
    {/if}
  </ol>

  {#if carry}
    <p class="carry" data-testid="handoff-carry">{carry}</p>

    <div>
      <button class="primary" onclick={copy} data-testid="handoff-copy">
        {copied ? 'Copied' : kind === 'device' ? 'Copy the words' : 'Copy the link'}
      </button>
    </div>
  {/if}

  <p class="muted small">
    Nothing has been used up yet. The {kind === 'device' ? 'link' : 'invite'} is still waiting, and will
    still work when you get to it.
  </p>

  <div>
    <button class="ghost" onclick={oncontinue} data-testid="handoff-continue">
      I play in this browser — carry on here
    </button>
  </div>
</div>

<style>
  h2 {
    margin: 0 0 0.35rem;
  }

  ol {
    margin: 0;
    padding-left: 1.2rem;
    color: var(--fg-muted);
    font-size: 0.9rem;
    display: grid;
    gap: 0.3rem;
  }

  /* Selectable, and wrapping rather than scrolling: what the button cannot
     copy has to be copyable by hand. */
  .carry {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--fg) 6%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
    user-select: all;
  }

  .small {
    font-size: 0.8rem;
    margin: 0;
  }

  .ghost {
    background: none;
    border: none;
    padding: 0.25rem 0;
    color: var(--fg-muted);
    font-size: 0.85rem;
    text-decoration: underline;
  }
</style>
