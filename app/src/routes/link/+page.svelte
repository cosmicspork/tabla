<script lang="ts">
  /**
   * Becoming one of someone's devices.
   *
   * Typing is the primary way in, not scanning: this is most often a laptop,
   * where a camera is awkward or absent and the words are being read aloud from
   * a phone across the room. The scanner is offered when the browser has one.
   *
   * Where the browser is not where this person will end up playing, the form is
   * held back first. Taking a link adopts a whole installation into whatever
   * storage this page happens to be in, and spends the link doing it — so on
   * iOS, where a scanned code opens Safari and the Home Screen app cannot see
   * what Safari keeps, linking here would hand the games to a tab and leave the
   * installed app empty with nothing left to link.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import Mark from '$lib/components/Mark.svelte';
  import OpenInApp from '$lib/components/OpenInApp.svelte';
  import StatusBanner from '$lib/components/StatusBanner.svelte';
  import { opensOutsideTheApp } from '$lib/handoff.ts';
  import { identityExists } from '$lib/identity.ts';
  import { LinkError, LINK_WORD_COUNT, takeLink, unknownWords } from '$lib/link.ts';
  import { MAX_NAME_LENGTH } from '$lib/profile.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { scanForWords, scanningAvailable } from '$lib/scan.ts';

  let words = $state('');
  let name = $state('');
  let busy = $state(false);
  let failure = $state('');
  let scanning = $state(false);

  /**
   * Whether to send this person to the installed app before anything is spent.
   *
   * `null` while we are finding out, which is a third state worth having: the
   * form is what must not be shown too early, and showing it for a frame is
   * showing it.
   *
   * A browser that already holds an identity is somebody's real installation,
   * whatever the platform does with links, and is left alone.
   */
  let elsewhere = $state<boolean | null>(null);

  $effect(() => {
    pageTitle.text = 'Link this device';
  });

  $effect(() => {
    void (async () => {
      elsewhere = opensOutsideTheApp() && !(await identityExists());
    })();
  });

  // The words may arrive in the fragment, from a scan on another app or a tap
  // on the QR code. Like an invite's key, a fragment is never sent to a server.
  $effect(() => {
    const fragment = page.url.hash.replace(/^#/, '');
    if (fragment && !words) words = decodeURIComponent(fragment).replace(/-/g, ' ');
  });

  const missing = $derived(unknownWords(words));
  const ready = $derived(
    words
      .trim()
      .split(/[\s-]+/)
      .filter(Boolean).length === LINK_WORD_COUNT && missing.length === 0,
  );

  async function scan() {
    scanning = true;
    failure = '';
    try {
      const found = await scanForWords();
      if (found) words = found;
    } catch (error) {
      failure = error instanceof Error ? error.message : 'The camera could not be opened.';
    } finally {
      scanning = false;
    }
  }

  async function link() {
    busy = true;
    failure = '';
    try {
      await takeLink(words, name);
      await goto('/?linked=1');
    } catch (error) {
      failure = describe(error);
    } finally {
      busy = false;
    }
  }

  function describe(error: unknown): string {
    if (!(error instanceof LinkError)) {
      return error instanceof Error ? error.message : String(error);
    }

    switch (error.reason) {
      case 'unknown-words':
        return `That is not ${LINK_WORD_COUNT} words from the list. Check the spelling.`;
      case 'taken':
        return 'Another device has already used that link. Start a new one on your other device.';
      case 'expired':
        return 'That link has expired. Start a new one on your other device.';
      case 'unreadable':
        return 'The link arrived damaged. Start a new one on your other device.';
      default:
        return 'No link with those words. Check them, or start a new one on your other device.';
    }
  }
</script>

<div class="link">
  <Mark size={56} />

  <div>
    <h1>Link this device</h1>
    <p class="muted">
      On the device you already play from, open Settings → Devices → Link a new device.
    </p>
  </div>

  {#if elsewhere}
    <OpenInApp kind="device" {words} oncontinue={() => (elsewhere = false)} />
  {:else if elsewhere === false}
    {#if failure}
      <StatusBanner text={failure} tone="warn" />
    {/if}

    <section class="card stack">
      <label>
        <span class="muted">The words from your other device</span>
        <input
          bind:value={words}
          autocapitalize="none"
          autocomplete="off"
          spellcheck="false"
          placeholder="harbor linen quartz meadow copper sable"
          data-testid="link-words-input"
        />
      </label>

      {#if missing.length > 0}
        <p class="muted small" data-testid="unknown-words">
          Not on the list: {missing.join(', ')}
        </p>
      {/if}

      {#if scanningAvailable()}
        <div>
          <button onclick={scan} disabled={scanning}>
            {scanning ? 'Looking…' : 'Scan the code instead'}
          </button>
        </div>
      {/if}
    </section>

    <section class="card stack">
      <label>
        <span class="muted">What should we call this device?</span>
        <input
          bind:value={name}
          maxlength={MAX_NAME_LENGTH}
          placeholder="Laptop"
          data-testid="device-name"
        />
      </label>
      <p class="muted small">Only you see this. It tells your devices apart in Settings.</p>
    </section>

    <button class="primary" onclick={link} disabled={!ready || busy} data-testid="do-link">
      {busy ? 'Linking…' : 'Link this device'}
    </button>
  {/if}

  <a class="muted back" href="/">Never mind</a>
</div>

<style>
  .link {
    display: grid;
    gap: 1rem;
    justify-items: stretch;
    max-width: 26rem;
    margin: 0 auto;
    padding-top: 1.5rem;
  }

  .link :global(.mark) {
    justify-self: center;
  }

  h1 {
    font-size: 1.5rem;
    margin: 0 0 0.35rem;
  }

  label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.85rem;
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
