<script lang="ts">
  import '../app.css';

  import AppHeader from '$lib/components/AppHeader.svelte';
  import { captureSimulationFlag } from '$lib/lifecycle.ts';
  import { applyTheme, loadTheme } from '$lib/theme.ts';

  let { children } = $props();

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
  <AppHeader />

  <main>
    {@render children()}
  </main>
</div>

<style>
  .shell {
    max-width: 34rem;
    margin: 0 auto;
    padding: 1rem 1rem 4rem;
  }
</style>
