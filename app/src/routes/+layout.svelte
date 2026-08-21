<script lang="ts">
  import '../app.css';

  import { page } from '$app/state';

  import AppHeader from '$lib/components/AppHeader.svelte';
  import Removed from '$lib/components/Removed.svelte';
  import Welcome from '$lib/components/Welcome.svelte';
  import { removedBy } from '$lib/devices.ts';
  import { removed } from '$lib/removed.svelte.ts';
  import { captureSimulationFlag } from '$lib/lifecycle.ts';
  import { hasOnboarded } from '$lib/profile.ts';
  import { applyTheme, loadTheme } from '$lib/theme.ts';

  let { children } = $props();

  /**
   * Whether first run is behind us. `null` while we are still finding out,
   * which is a third state worth having: rendering the welcome screen for a
   * frame to someone who has been playing for months would be alarming.
   */
  let onboarded = $state<boolean | null>(null);

  /**
   * Which of this person's other devices removed this one, if one has.
   *
   * Unlike the welcome screen this does stand in front of everything: a device
   * that has been signed out cannot usefully do anything, and letting it open a
   * game would be letting it write a move nobody will accept.
   */
  const signedOutBy = $derived(removed.by);

  /**
   * The welcome screen interrupts the game list, not the app.
   *
   * Anywhere else, the person already knows where they were going: an invite
   * link came to join a game, and the welcome screen's own offer of restoring
   * a backup leads to a settings page — which it would be standing in front
   * of, if it stood in front of everything.
   */
  const atHome = $derived(page.route.id === '/');

  $effect(() => {
    // Re-read on every navigation, not just at mount: redeeming an invite
    // introduces a device from outside this component, and a stale `false`
    // would put the welcome screen in front of the game it just joined.
    void page.route.id;
    void hasOnboarded().then((done) => (onboarded = done));
    void removedBy();
  });

  $effect(() => {
    captureSimulationFlag();
  });

  // The choice lives in the database, which cannot be read before the first
  // paint — so a device set to light while its owner chose dark flashes light
  // for a frame. The alternative is a second copy of the preference somewhere
  // synchronous, and a second copy is a thing that can disagree.
  $effect(() => {
    void loadTheme().then(applyTheme);
  });
</script>

<div class="shell">
  {#if signedOutBy !== undefined && page.route.id !== '/link'}
    <Removed by={signedOutBy} />
  {:else if onboarded === false && atHome}
    <Welcome onready={() => (onboarded = true)} />
  {:else if onboarded !== null}
    <AppHeader />

    <main>
      {@render children()}
    </main>
  {/if}
</div>

<style>
  .shell {
    max-width: 34rem;
    margin: 0 auto;
    padding: 1rem 1rem 4rem;
  }
</style>
