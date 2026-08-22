<script lang="ts">
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { loadTheme, setTheme, type ThemeChoice } from '$lib/theme.ts';

  let theme = $state<ThemeChoice>('system');

  $effect(() => {
    pageTitle.text = 'Appearance';
  });

  $effect(() => {
    void loadTheme().then((choice) => (theme = choice));
  });

  async function choose(choice: ThemeChoice) {
    theme = choice;
    await setTheme(choice);
  }

  const CHOICES: { value: ThemeChoice; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];
</script>

<section class="card stack">
  <div class="setting">
    <span class="label">
      Theme
      <small>System follows your device</small>
    </span>
  </div>
  <div class="segmented" role="group" aria-label="Theme">
    {#each CHOICES as choice (choice.value)}
      <button
        aria-pressed={theme === choice.value}
        onclick={() => choose(choice.value)}
        data-testid="theme-{choice.value}"
      >
        {choice.label}
      </button>
    {/each}
  </div>
</section>
