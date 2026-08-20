<script lang="ts">
  import '../app.css';

  import AppHeader from '$lib/components/AppHeader.svelte';
  import { captureSimulationFlag } from '$lib/lifecycle.ts';

  let { children } = $props();

  $effect(() => {
    captureSimulationFlag();
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
