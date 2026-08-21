<script lang="ts">
  /**
   * Redeeming an invite link.
   *
   * The key arrives in `location.hash`, which the browser never transmits. It is
   * read here, on the device, and used to open a blob the relay cannot read.
   *
   * Nothing is claimed until we know this is the browser the person plays in.
   * Claiming is what spends the invite — it works exactly once — and it is also
   * what generates an identity, so doing it in the wrong place is not a wrong
   * window but a lost game: on iOS a tapped link opens Safari however the app
   * was installed, and Safari cannot see the Home Screen app's storage. Which of
   * the two this is cannot be read from inside the wrong one, so where it can go
   * wrong, and only where there is no identity here to go on, we ask. One tap
   * from someone genuinely new, against an invite that cannot be got back.
   */
  import { goto } from '$app/navigation';

  import OpenInApp from '$lib/components/OpenInApp.svelte';
  import StatusBanner from '$lib/components/StatusBanner.svelte';

  import { joinGame } from '$lib/games.ts';
  import { opensOutsideTheApp } from '$lib/handoff.ts';
  import { identityExists } from '$lib/identity.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';

  let phase = $state<'deciding' | 'asking' | 'elsewhere' | 'working' | 'failed'>('deciding');
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
    pageTitle.text = 'Invitation';
  });

  $effect(() => {
    void begin();
  });

  async function begin() {
    // Somebody who has played in this browser before is in the right place by
    // definition, whatever the platform does with links.
    if (!opensOutsideTheApp() || (await identityExists())) {
      await redeem();
      return;
    }

    phase = 'asking';
  }

  async function redeem() {
    phase = 'working';
    const result = await joinGame(location.hash);

    if (result.ok) {
      await goto(`/g/${encodeURIComponent(result.game.gameId)}`, { replaceState: true });
      return;
    }

    reason = messages[result.reason] ?? 'Something went wrong opening this invite.';
    phase = 'failed';
  }
</script>

{#if phase === 'asking'}
  <div class="card stack">
    <div>
      <h2>Someone has invited you to a game</h2>
      <p class="muted">
        One thing first, because an invite works only once: on iPhone and iPad the tabla app and
        this browser keep separate games, and a link always opens the browser.
      </p>
    </div>

    <button class="primary" onclick={redeem} data-testid="join-new-here">
      I'm new to tabla — open it here
    </button>
    <button onclick={() => (phase = 'elsewhere')} data-testid="join-already-play">
      I already play, on the app
    </button>
  </div>
{:else if phase === 'elsewhere'}
  <OpenInApp kind="invite" link={location.href} oncontinue={redeem} />
{:else if phase === 'failed'}
  <StatusBanner text="Could not join" tone="warn" />
  <p class="muted">{reason}</p>
{:else if phase === 'working'}
  <StatusBanner text="Joining…" spinner />
  <p class="muted">Unlocking the invite on your device.</p>
{:else}
  <!-- Still working out whether this is the browser they play in. Not
       "Joining…", because that is the thing we have not done yet. -->
  <StatusBanner text="Opening…" spinner />
{/if}

<style>
  h2 {
    margin: 0 0 0.35rem;
  }

  button {
    width: 100%;
  }
</style>
