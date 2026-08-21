<script lang="ts" generics="T">
  /**
   * Pointing the camera at a code.
   *
   * The picture is the feature. Before this there was a scanner, but the video
   * element it decoded was never put on the page — the camera opened, ran for
   * twenty seconds and gave up, while the person aimed a lens they could not
   * see. A viewfinder is not decoration on a scanner; it is the part that tells
   * you where to point.
   *
   * What counts as a hit is the caller's business. `recognise` is handed the raw
   * text of every code that decodes and returns null for anything it does not
   * want, which is most of what a camera catches — a stray code on a poster is
   * not an error, it is a frame to keep scanning past. Because that function is
   * the same one behind the paste box, a scan cannot accept something a paste
   * would refuse.
   *
   * Frames are read here and nowhere else: no image is uploaded, stored, or kept
   * after the loop moves on, and the camera is released the moment this closes.
   */
  import { onDestroy, onMount } from 'svelte';

  import { reader, type Reader } from '$lib/scan.ts';

  let {
    recognise,
    ondetect,
    onclose,
    label = 'Point the camera at the code.',
  }: {
    /** Raw decoded text in, something useful out, or null to keep looking. */
    recognise: (text: string) => T | null;
    ondetect: (found: T) => void;
    onclose: () => void;
    label?: string;
  } = $props();

  let video = $state<HTMLVideoElement>();
  let failure = $state('');

  let stream: MediaStream | null = null;
  let frame = 0;
  let read: Reader | null = null;
  /** Guards the loop against a frame that resolves after teardown. */
  let live = true;

  async function start() {
    try {
      // The back camera by preference; a laptop has only the one and gives it.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
    } catch (error) {
      // Refused and unavailable are different sentences to a person: one is a
      // decision they can revisit, the other is not about them at all.
      failure =
        (error as { name?: string }).name === 'NotAllowedError'
          ? 'The camera was not allowed. You can type the code instead.'
          : 'This device would not open a camera. You can type the code instead.';
      return;
    }

    if (!live) {
      // Closed while permission was being asked. Nothing has been shown, and
      // the tracks would otherwise be left running behind a dismissed sheet.
      stop();
      return;
    }

    if (video) {
      video.srcObject = stream;
      // Some engines reject play() on an element being torn down mid-navigation;
      // the loop tolerates a video that is not ready yet, so this is not fatal.
      await video.play().catch(() => {});
    }

    read = await reader();
    frame = requestAnimationFrame(tick);
  }

  async function tick() {
    if (!live) return;

    // readyState below HAVE_CURRENT_DATA means there is no picture to read yet.
    if (!video || !read || video.readyState < 2) {
      frame = requestAnimationFrame(tick);
      return;
    }

    let text: string | null = null;
    try {
      text = await read(video);
    } catch {
      // One frame failing to decode says nothing about the next one.
    }

    if (!live) return;

    const found = text === null ? null : recognise(text);
    if (found !== null && found !== undefined) {
      stop();
      ondetect(found);
      return;
    }

    frame = requestAnimationFrame(tick);
  }

  /** Release everything, so the camera light goes out when this goes away. */
  function stop() {
    live = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  }

  function close() {
    stop();
    onclose();
  }

  onMount(start);
  onDestroy(stop);
</script>

<div class="card stack">
  {#if failure}
    <p class="notice warn">{failure}</p>
    <button class="primary" onclick={onclose} data-testid="scanner-dismiss">
      Type it instead
    </button>
  {:else}
    <div class="viewport">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} playsinline muted data-testid="scanner-video"></video>
      <div class="reticle" aria-hidden="true"></div>
    </div>

    <p class="muted small">
      {label} It is read on this device — no picture of it goes anywhere.
    </p>

    <div>
      <button onclick={close} data-testid="scanner-cancel">Cancel</button>
    </div>
  {/if}
</div>

<style>
  .viewport {
    position: relative;
    aspect-ratio: 1;
    max-width: 18rem;
    width: 100%;
    margin: 0 auto;
    overflow: hidden;
    border-radius: var(--radius);
    background: #000;
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* Somewhere to aim. The decoder reads the whole frame, so this is guidance
     rather than a boundary — which is why it is drawn faintly and inset. */
  .reticle {
    position: absolute;
    inset: 15%;
    border: 2px solid rgba(255, 255, 255, 0.75);
    border-radius: 0.5rem;
    pointer-events: none;
  }

  .small {
    font-size: 0.8rem;
    margin: 0;
  }
</style>
