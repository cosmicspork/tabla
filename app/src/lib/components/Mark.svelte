<script lang="ts">
  /**
   * The tabla mark, drawn from `$lib/mark.ts`.
   *
   * The plate is the accent and the letter is the page background, which is the
   * one combination that holds up on both a light and a dark launcher without
   * needing two artworks.
   */
  import { PLATE_RADIUS, tileMark, VIEW_BOX } from '$lib/mark.ts';

  let { size = 28, small = false }: { size?: number; small?: boolean } = $props();
</script>

<svg
  class="mark"
  viewBox="0 0 {VIEW_BOX} {VIEW_BOX}"
  width={size}
  height={size}
  role="presentation"
  aria-hidden="true"
>
  <rect width={VIEW_BOX} height={VIEW_BOX} rx={PLATE_RADIUS} fill="var(--accent)" />
  <path d={tileMark(small)} fill="var(--bg)" />
</svg>

<style>
  .mark {
    display: block;
    flex: none;
  }
</style>
