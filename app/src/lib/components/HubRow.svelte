<script lang="ts">
  /**
   * One destination in a settings hub.
   *
   * The summary is live data rather than a description — "On · a nudge when
   * it's your turn", "Letras, 1.4 MB" — so the hub doubles as a status page and
   * most questions are answered without opening anything.
   *
   * Glyphs are inline SVG paths, never characters: a font that lacks the
   * codepoint substitutes something else, and an emoji-capable one renders in
   * colour among monochrome siblings.
   */
  let {
    href,
    title,
    summary,
    glyph,
  }: {
    href: string;
    title: string;
    summary: string;
    /** The `d` of a 24×24 stroked path, or several separated by spaces. */
    glyph: readonly string[];
  } = $props();
</script>

<a class="hub-row" {href} data-testid="settings-row">
  <svg class="glyph" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    {#each glyph as d, index (index)}
      <path {d} />
    {/each}
  </svg>
  <span class="text">
    <b>{title}</b>
    <span>{summary}</span>
  </span>
  <svg class="chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M9 5l7 7-7 7" />
  </svg>
</a>
