<script lang="ts">
  import BackupPanel from '$lib/components/BackupPanel.svelte';
  import { pageTitle } from '$lib/page-title.svelte.ts';

  $effect(() => {
    pageTitle.text = 'Backup & restore';
  });
</script>

<div class="stack">
  <BackupPanel />
</div>
