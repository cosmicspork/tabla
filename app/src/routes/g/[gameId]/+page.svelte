<script lang="ts">
  import { page } from '$app/state';

  import type { Component } from 'svelte';

  import InviteShare from '$lib/components/InviteShare.svelte';
  import NotifyPrompt from '$lib/components/NotifyPrompt.svelte';
  import { getGame } from '$lib/db/store.ts';
  import type { GameRecord } from '$lib/db/schema.ts';
  import { GameSession, type BoardState } from '$lib/game-session.ts';
  import { refreshPendingGame } from '$lib/games.ts';
  import { onShouldResync } from '$lib/lifecycle.ts';
  import { currentSubscription } from '$lib/push.ts';
  import { gameEntry, titleOf, type BoardProps } from '$lib/registry.ts';
  import type { PushSubscriptionJson } from '@tabla/shared';

  const gameId = $derived(decodeURIComponent(page.params.gameId ?? ''));

  let game = $state<GameRecord | null>(null);
  let session = $state<GameSession | null>(null);
  let board = $state<BoardState | null>(null);
  let Board = $state<Component<BoardProps> | null>(null);
  let failure = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    const id = gameId;
    void start(id);

    // Sync when the app comes forward, when the network returns, and when a
    // push wakes us. iOS gives a web app no background execution, so these are
    // the moments that actually exist.
    const stopWatching = onShouldResync(() => {
      void session?.resync();
    });

    return () => {
      stopWatching();
      if (pollTimer) clearInterval(pollTimer);
      session?.disconnect();
      session = null;
    };
  });

  async function start(id: string) {
    const record = await getGame(id);
    if (!record) {
      failure = 'That game is not on this device.';
      return;
    }
    game = record;

    if (record.status === 'pending') return watchForClaim(id);
    if (record.status === 'incompatible') return;

    await play(record);
  }

  /** While the invite is unclaimed, poll until someone takes it. */
  function watchForClaim(id: string) {
    const tick = async () => {
      const updated = await refreshPendingGame(id).catch(() => undefined);
      if (updated && updated.status === 'active') {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        game = updated;
        await play(updated);
      }
    };

    pollTimer = setInterval(() => void tick(), 3000);
    void tick();
  }

  async function play(record: GameRecord) {
    try {
      // Boards are per-game and loaded on demand, so a build with a dozen games
      // does not ship a dozen boards to someone playing one of them. This lives
      // here rather than at the top of `start` because a game that began as a
      // pending invite arrives by the other path.
      const entry = gameEntry(record.pluginId);
      if (entry) Board = (await entry.board()).default;

      const opened = await GameSession.open(record);
      session = opened;

      opened.subscribe((next) => {
        board = next;
      });

      await opened.connect();
      await opened.writePrologueIfNeeded();

      // If this device already has a subscription, re-register it: room state
      // is per game, and a game created later would not otherwise know about it.
      const existing = await currentSubscription();
      if (existing) opened.subscribeToPush(existing);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  async function onplay(move: unknown) {
    try {
      await session?.play(move);
    } catch (error) {
      // Rejected by the rules, so it was never written to the log.
      failure = error instanceof Error ? error.message : String(error);
      setTimeout(() => (failure = null), 2500);
    }
  }

  async function resign() {
    if (confirm('Resign this game? This cannot be undone.')) await session?.resign();
  }

  const statusLine = $derived.by(() => {
    if (!board) return '';
    if (board.outcome) {
      if (board.outcome.kind === 'draw') return 'A draw.';
      return board.outcome.player === board.player ? 'You won.' : 'You lost.';
    }
    return board.view.yourTurn ? 'Your turn.' : 'Waiting for your opponent.';
  });

  const connection = $derived.by(() => {
    if (!board) return '';
    if (board.pending > 0) return 'Saved on this device — will sync when you are back online.';
    if (board.status === 'offline') return 'Offline. Your moves are safe on this device.';
    if (board.status === 'refused') return 'The relay refused something. Your log is unchanged.';
    if (board.status === 'diverged')
      return 'The relay holds a different history. Nothing accepted.';
    return '';
  });
</script>

<p><a href="/">← All games</a></p>

{#if failure}
  <p class="notice warn">{failure}</p>
{/if}

{#if game?.status === 'pending'}
  <h1>Waiting for a player</h1>
  {#if game.blobKey}
    <InviteShare link={`${location.origin}/j#${game.blobId}.${game.blobKey}`} />
  {/if}
  <p class="muted">This page will move on by itself as soon as someone joins.</p>
{:else if game?.status === 'incompatible'}
  <h1>Version mismatch</h1>
  <p class="notice warn">
    This game needs a different version of the rules than this build has. Playing anyway would mean
    the two of you disagreeing about legal moves partway through, which cannot be repaired — so it
    is refused up front.
  </p>
{:else if board && Board}
  <h1>{titleOf(game?.pluginId ?? '')}</h1>
  <p class="status">{statusLine}</p>

  <Board {board} {onplay} />

  {#if connection}
    <p class="notice">{connection}</p>
  {/if}

  {#if !board.outcome}
    <button class="danger" onclick={resign}>Resign</button>
  {/if}

  <div class="notify">
    <NotifyPrompt
      onsubscribe={(subscription: PushSubscriptionJson) => session?.subscribeToPush(subscription)}
    />
  </div>
{:else if !failure}
  <h1>Loading…</h1>
{/if}

<style>
  .status {
    font-size: 1.05rem;
    margin-bottom: 0;
  }

  .notify {
    margin-top: 2rem;
  }
</style>
