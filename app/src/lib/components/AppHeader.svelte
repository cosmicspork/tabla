<script lang="ts">
  /**
   * The one piece of chrome every screen shares.
   *
   * Home is the mark and the name; everywhere else is a back arrow and the name
   * of the page you are on. The right-hand slot is the cog, and it is absent
   * inside settings because that is where it would take you.
   *
   * Exactly one `h1` per screen: on home the wordmark is it, elsewhere the page
   * title is, so a page never renders a heading of its own.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import Mark from './Mark.svelte';
  import { pageTitle } from '$lib/page-title.svelte.ts';

  const onHome = $derived(page.route.id === '/');
  const inSettings = $derived(page.route.id?.startsWith('/settings') ?? false);

  /**
   * Back goes back, unless there is nowhere to go back to.
   *
   * A push notification or a shared link opens a game page cold, with no
   * history behind it; walking back out of the app would be the wrong answer,
   * so that case lands on the game list instead.
   */
  function back() {
    if (history.length > 1) history.back();
    else void goto('/');
  }
</script>

<header>
  {#if onHome}
    <h1 class="brand">
      <Mark size={28} />
      tabla
    </h1>
  {:else}
    <button class="icon" onclick={back} aria-label="Back" data-testid="nav-back">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <h1 class="title">{pageTitle.text}</h1>
  {/if}

  {#if !inSettings}
    <a class="icon" href="/settings" aria-label="Settings" data-testid="nav-settings">
      <!-- A gear, not a rayed circle: rays read as brightness, and this is not
           a brightness control. -->
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        />
      </svg>
    </a>
  {/if}
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-block: 0.75rem 1.25rem;
  }

  .brand,
  .title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.2;
    /* The title takes the slack, so the cog stays pinned to the right. */
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    /* Comfortably past the 44px touch target, without pushing the bar taller. */
    width: 2.75rem;
    height: 2.75rem;
    margin-inline: -0.6rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--fg-muted);
    border-radius: 50%;
  }

  .icon svg {
    width: 1.35rem;
    height: 1.35rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Only real pointers get the brighten: on touch, iOS leaves :hover stuck on
     whatever was tapped last, so the cog stays lit after you come back from
     settings. */
  @media (hover: hover) {
    .icon:hover {
      color: var(--fg);
    }
  }
</style>
