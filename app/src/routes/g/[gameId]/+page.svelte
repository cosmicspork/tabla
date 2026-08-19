<script lang="ts">
  import { page } from '$app/state';

  import Board from '$lib/components/Board.svelte';
  import InviteShare from '$lib/components/InviteShare.svelte';
  import { getGame } from '$lib/db/store.ts';
  import type { GameRecord } from '$lib/db/schema.ts';
  import { GameSession, type BoardState } from '$lib/game-session.ts';
  import { refreshPendingGame } from '$lib/games.ts';

  const gameId = $derived(decodeURIComponent(page.params.gameId ?? ''));

  let game = $state<GameRecord | null>(null);
  let session = $state<GameSession | null>(null);
  let board = $state<BoardState | null>(null);
  let failure = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    const id = gameId;
    void start(id);

    return () => {
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
      const opened = await GameSession.open(record);
      session = opened;

      opened.subscribe((next) => {
        board = next;
      });

      await opened.connect();
      await opened.writePrologueIfNeeded();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  async function onplay(cell: number) {
    try {
      await session?.play({ cell });
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
    if (board.status === 'diverged') return 'The relay holds a different history. Nothing accepted.';
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
{:else if board}
  <h1>Tic tac toe</h1>
  <p class="status">{statusLine}</p>

  <Board {board} {onplay} />

  {#if connection}
    <p class="notice">{connection}</p>
  {/if}

  {#if !board.outcome}
    <button class="danger" onclick={resign}>Resign</button>
  {/if}
{:else if !failure}
  <h1>Loading…</h1>
{/if}

<style>
  .status {
    font-size: 1.05rem;
    margin-bottom: 0;
  }
</style>
