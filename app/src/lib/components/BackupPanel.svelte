<script lang="ts">
  import {
    backupFilename,
    downloadBackup,
    exportBackup,
    importBackup,
    type ImportSummary,
  } from '$lib/backup.ts';

  let exportPassphrase = $state('');
  let importPassphrase = $state('');
  let file = $state<File | null>(null);
  let busy = $state(false);
  let message = $state<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  let confirmingImport = $state(false);

  async function save() {
    if (exportPassphrase.length < 8) {
      message = {
        kind: 'warn',
        text: 'Use at least 8 characters — this protects your identity key.',
      };
      return;
    }

    busy = true;
    try {
      downloadBackup(await exportBackup(exportPassphrase), backupFilename());
      message = { kind: 'ok', text: 'Backup saved. Keep it somewhere you would keep a password.' };
      exportPassphrase = '';
    } catch (error) {
      message = { kind: 'warn', text: describe(error) };
    } finally {
      busy = false;
    }
  }

  async function restore() {
    if (!file) return;

    busy = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const summary: ImportSummary = await importBackup(importPassphrase, bytes);
      message = {
        kind: 'ok',
        text: `Restored ${summary.games} game${summary.games === 1 ? '' : 's'} and ${summary.contacts} contact${summary.contacts === 1 ? '' : 's'}. Reload to see them.`,
      };
      importPassphrase = '';
      file = null;
      confirmingImport = false;
    } catch (error) {
      message = { kind: 'warn', text: describe(error) };
    } finally {
      busy = false;
    }
  }

  function describe(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    // The crypto layer deliberately does not distinguish wrong-key from
    // corrupt-file, so the wording covers both honestly.
    if (/decryption/i.test(text)) return 'Wrong passphrase, or the file is damaged.';
    if (/format/i.test(text)) return 'That does not look like a tabla backup.';
    return text;
  }
</script>

<section class="card stack">
  <div>
    <h2>Back up your games</h2>
    <p class="muted">
      The backup holds your games <em>and</em> your identity key. Without the key the games cannot be
      read at all, so the two travel together — and the file is worth protecting accordingly.
    </p>
  </div>

  <label>
    <span class="muted">Passphrase</span>
    <input
      type="password"
      bind:value={exportPassphrase}
      autocomplete="new-password"
      placeholder="At least 8 characters"
    />
  </label>

  <div>
    <button class="primary" onclick={save} disabled={busy}>
      {busy ? 'Working…' : 'Download backup'}
    </button>
  </div>
</section>

<section class="card stack">
  <div>
    <h2>Move to a new device</h2>
    <p class="muted">
      Restoring replaces this device's identity with the one in the backup. Two devices signing as
      the same player would fork every shared game the moment both moved, so this is a move rather
      than a merge.
    </p>
  </div>

  <label>
    <span class="muted">Backup file</span>
    <input
      type="file"
      accept=".tabla,application/octet-stream"
      onchange={(event) => (file = event.currentTarget.files?.[0] ?? null)}
    />
  </label>

  <label>
    <span class="muted">Passphrase</span>
    <input type="password" bind:value={importPassphrase} autocomplete="current-password" />
  </label>

  {#if confirmingImport}
    <p class="notice warn">This will replace everything on this device. Continue?</p>
    <div class="row">
      <button class="danger" onclick={restore} disabled={busy}>
        {busy ? 'Restoring…' : 'Yes, replace this device'}
      </button>
      <button onclick={() => (confirmingImport = false)}>Cancel</button>
    </div>
  {:else}
    <div>
      <button onclick={() => (confirmingImport = true)} disabled={!file || busy}>Restore</button>
    </div>
  {/if}
</section>

{#if message}
  <p class="notice" class:warn={message.kind === 'warn'}>{message.text}</p>
{/if}

<style>
  label {
    display: grid;
    gap: 0.25rem;
  }

  label span {
    font-size: 0.85rem;
  }

  input[type='file'] {
    font: inherit;
    font-size: 0.9rem;
  }
</style>
