<script lang="ts">
  import {
    backupFilename,
    downloadBackup,
    exportBackup,
    importBackup,
    type ImportSummary,
  } from '$lib/backup.ts';
  import { setMeta } from '$lib/db/store.ts';

  type Message = { kind: 'ok' | 'warn'; text: string } | null;

  /** Short enough to be worth refusing before the button is ever pressed. */
  const MIN_PASSPHRASE = 8;

  let exportPassphrase = $state('');
  let importPassphrase = $state('');
  let file = $state<File | null>(null);
  let busy = $state(false);
  /**
   * One message per form, rendered beside the button that produced it.
   *
   * They used to share a single line at the bottom of the panel, which put the
   * export's complaint underneath the restore form — below the fold, next to a
   * control that had nothing to do with it.
   */
  let exportMessage = $state<Message>(null);
  let importMessage = $state<Message>(null);
  let confirmingImport = $state(false);

  const passphraseReady = $derived(exportPassphrase.length >= MIN_PASSPHRASE);

  async function save() {
    busy = true;
    exportMessage = null;
    try {
      downloadBackup(await exportBackup(exportPassphrase), backupFilename());
      // Only the date, and only so settings can say how long ago it was. A
      // person who cannot remember whether they have ever made one is the
      // person most likely to need one.
      await setMeta('lastBackupAt', Date.now());
      exportMessage = {
        kind: 'ok',
        text: 'Backup saved. Keep it somewhere you would keep a password.',
      };
      exportPassphrase = '';
    } catch (error) {
      exportMessage = { kind: 'warn', text: describe(error) };
    } finally {
      busy = false;
    }
  }

  async function restore() {
    if (!file) return;

    busy = true;
    importMessage = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const summary: ImportSummary = await importBackup(importPassphrase, bytes);
      importMessage = {
        kind: 'ok',
        text: `This device is now one of yours. Restored ${summary.games} game${summary.games === 1 ? '' : 's'} and ${summary.contacts} contact${summary.contacts === 1 ? '' : 's'}. Reload to see them.`,
      };
      importPassphrase = '';
      file = null;
      confirmingImport = false;
    } catch (error) {
      importMessage = { kind: 'warn', text: describe(error) };
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
    <p class="muted">Your games and your identity, in one encrypted file.</p>
  </div>

  <label>
    <span class="muted">Passphrase <span class="required">· required</span></span>
    <input
      type="password"
      bind:value={exportPassphrase}
      autocomplete="new-password"
      placeholder="At least {MIN_PASSPHRASE} characters"
      aria-describedby="export-requirement"
    />
  </label>

  {#if exportPassphrase.length > 0 && !passphraseReady}
    <p class="muted hint" id="export-requirement">
      {MIN_PASSPHRASE - exportPassphrase.length} more character{MIN_PASSPHRASE -
        exportPassphrase.length ===
      1
        ? ''
        : 's'} to go.
    </p>
  {/if}

  {#if exportMessage}
    <p class="notice" class:warn={exportMessage.kind === 'warn'}>{exportMessage.text}</p>
  {/if}

  <div>
    <button class="primary" onclick={save} disabled={busy || !passphraseReady}>
      {busy ? 'Working…' : 'Download backup'}
    </button>
  </div>

  <details class="muted small">
    <summary>Why a passphrase is required</summary>
    <p>
      The file holds your identity key as well as your games — without the key the games cannot be
      read at all, so the two have to travel together. That makes the file worth exactly as much as
      your account would be if there were one, which is why it is never written unencrypted.
    </p>
  </details>
</section>

<section class="card stack">
  <div>
    <h2>If you lose every device</h2>
    <p class="muted">
      Replaces everything here with the contents of a backup. To play from a device you still have, <a
        href="/settings/devices">link it</a
      > instead — that keeps both.
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

  {#if importMessage}
    <p class="notice" class:warn={importMessage.kind === 'warn'}>{importMessage.text}</p>
  {/if}

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

  <details class="muted small">
    <summary>Why this replaces what is here</summary>
    <p>
      Restoring takes on the identity in the backup, and a device can only be one person. What is
      already on this one is not merged with it — there is no way to reconcile two histories of the
      same game — so it is replaced. Afterwards this device is one of that identity's, beside any
      others still running.
    </p>
  </details>
</section>

<style>
  label {
    display: grid;
    gap: 0.25rem;
  }

  label span {
    font-size: 0.85rem;
  }

  .required {
    color: var(--danger);
  }

  .hint {
    margin: -0.4rem 0 0;
    font-size: 0.8rem;
  }

  input[type='file'] {
    font: inherit;
    font-size: 0.9rem;
  }

  .small {
    font-size: 0.8rem;
  }

  .small summary {
    cursor: pointer;
  }

  .small p {
    margin: 0.5rem 0 0;
  }
</style>
