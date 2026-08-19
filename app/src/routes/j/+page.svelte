<script lang="ts">
  /**
   * Redeeming an invite link.
   *
   * The key arrives in `location.hash`, which the browser never transmits. It is
   * read here, on the device, and used to open a blob the relay cannot read.
   */
  import { goto } from '$app/navigation';

  import { joinGame } from '$lib/games.ts';

  let phase = $state<'working' | 'failed'>('working');
  let reason = $state<string>('');

  const messages: Record<string, string> = {
    taken: 'This link has already been used. Invite links work exactly once — ask for a new one.',
    expired: 'This invite expired. Invites last seven days.',
    missing: 'This invite could not be found. It may have expired or never existed.',
    malformed: 'This link is incomplete. Copy the whole thing, including the part after the #.',
    incompatible:
      'This game was made with a different version of tabla, so the rules would not match. Update and ask for a new invite.',
  };

  $effect(() => {
    void redeem();
  });

  async function redeem() {
    const result = await joinGame(location.hash);

    if (result.ok) {
      await goto(`/g/${encodeURIComponent(result.game.gameId)}`, { replaceState: true });
      return;
    }

    reason = messages[result.reason] ?? 'Something went wrong opening this invite.';
    phase = 'failed';
  }
</script>

{#if phase === 'working'}
  <h1>Joining…</h1>
  <p class="muted">Unlocking the invite on your device.</p>
{:else}
  <h1>Could not join</h1>
  <p class="notice warn">{reason}</p>
  <a href="/">Back to your games</a>
{/if}
