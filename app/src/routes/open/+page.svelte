<script lang="ts">
  /**
   * Opening a link that arrived somewhere else.
   *
   * The other end of the hand-off. An installed app on iOS cannot be sent a
   * URL — there is no scheme for one, and a tapped link opens the browser
   * whatever the manifest says — so the way in is the person carrying it: copy
   * in Safari, paste here.
   *
   * That works at all because of where the secret lives. The part that matters
   * is the fragment, which never went to a server and does not need one to come
   * back: the same property that keeps the relay ignorant of what it is holding
   * is what lets a link be pasted from one browser into another and still open.
   *
   * Whatever survived the trip is accepted — a whole URL, a bare fragment, or
   * six words read aloud — because the alternative is telling somebody their
   * one-use link is not a link.
   *
   * Better still, when the code is on a screen in front of you: scan it here and
   * the trip does not happen at all. Reading it with the phone's own camera app
   * opens Safari, because that is what a camera app does with a URL; reading it
   * from inside the app skips the browser, the clipboard, and this page's whole
   * reason for existing. The scan and the paste end in the same parser, so
   * neither can accept what the other would refuse.
   */
  import { goto } from '$app/navigation';

  import QrScanner from '$lib/components/QrScanner.svelte';
  import { parseSharedLink } from '$lib/handoff.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { scanningAvailable } from '$lib/scan.ts';

  let text = $state('');
  let failure = $state('');
  let scanning = $state(false);

  $effect(() => {
    pageTitle.text = 'Open a link';
  });

  const link = $derived(parseSharedLink(text));

  /**
   * Reads the clipboard, from the tap that asked for it.
   *
   * A button rather than a peek on arrival: reading the clipboard unasked is
   * rude even where a browser allows it, and every browser that allows it at
   * all wants the gesture anyway.
   */
  async function pasteFromClipboard() {
    failure = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      failure = 'This browser would not hand over the clipboard. Paste into the box instead.';
    }
  }

  async function open() {
    const target = parseSharedLink(text);
    if (!target) {
      failure = 'That does not look like a tabla link. Paste the whole thing, # and all.';
      return;
    }

    await goto(target.to);
  }
</script>

<div class="stack">
  <!-- No heading of its own: the header carries the only `h1` on a screen. -->
  <p class="muted">
    Paste an invite link, or the six words from your other device. Links open in your browser rather
    than here — on iPhone and iPad there is no way for them not to — and this is how one gets
    across.
  </p>

  {#if failure}
    <p class="notice warn">{failure}</p>
  {/if}

  {#if scanning}
    <QrScanner
      recognise={parseSharedLink}
      label="Point the camera at the code."
      ondetect={(link) => {
        scanning = false;
        void goto(link.to);
      }}
      onclose={() => (scanning = false)}
    />
  {/if}

  <section class="card stack">
    <label>
      <span class="muted">The link, or the six words</span>
      <textarea
        bind:value={text}
        rows="3"
        autocapitalize="none"
        autocomplete="off"
        spellcheck="false"
        placeholder="https://…/j#… or harbor linen quartz meadow copper sable"
        data-testid="paste-link"
      ></textarea>
    </label>

    <div class="row">
      <button onclick={pasteFromClipboard} data-testid="paste-from-clipboard">Paste</button>
      {#if scanningAvailable()}
        <button onclick={() => (scanning = true)} data-testid="scan">Scan a code</button>
      {/if}
    </div>

    {#if link}
      <p class="muted small">
        {link.kind === 'invite'
          ? 'An invitation to a game. Opening it joins, and uses it up.'
          : 'A link from another of your devices. Opening it brings its games here.'}
      </p>
    {/if}
  </section>

  <button class="primary" onclick={open} disabled={!link} data-testid="do-open">Open it</button>

  <a class="muted back" href="/">Never mind</a>
</div>

<style>
  label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.85rem;
  }

  textarea {
    width: 100%;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
    resize: vertical;
  }

  .small {
    font-size: 0.8rem;
    margin: 0;
  }

  .back {
    justify-self: center;
    font-size: 0.85rem;
  }
</style>
