<script lang="ts">
  /**
   * One line at the top of a screen saying what the game is doing.
   *
   * It replaces status text scattered down the page: whose turn it is, what
   * the opponent just played, whether anything is still waiting to sync. A
   * person looking at a board wants all of that in one place, above the board,
   * and wants it announced rather than discovered.
   */
  let {
    text,
    detail = '',
    tone = 'info',
    spinner = false,
  }: {
    text: string;
    detail?: string;
    tone?: 'info' | 'warn';
    spinner?: boolean;
  } = $props();
</script>

<p class="banner" class:warn={tone === 'warn'} aria-live="polite" data-testid="status">
  {#if spinner}<span class="spinner" aria-hidden="true"></span>{/if}
  <span class="text">{text}</span>
  {#if detail}<span class="detail">{detail}</span>{/if}
</p>

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.75rem;
    padding: 0.6rem 0.8rem;
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 0.95rem;
  }

  .banner.warn {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
  }

  .text {
    font-weight: 550;
  }

  .detail {
    margin-left: auto;
    font-weight: 400;
    font-size: 0.85rem;
    opacity: 0.8;
    text-align: right;
  }

  .spinner {
    flex: none;
    width: 0.85rem;
    height: 0.85rem;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      /* Still reads as "in progress" rather than as a stray dot. */
      opacity: 0.6;
    }
  }
</style>
