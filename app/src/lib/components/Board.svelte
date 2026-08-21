<script lang="ts">
  import type { BoardState } from '$lib/game-session.ts';

  // `onplay` takes whatever this game's rules call a move — a cell number here.
  // The plugin owns the encoding, so the shape has to agree with the rules and
  // never with the relay, which sees only ciphertext either way.
  let {
    board,
    onplay,
    locked = false,
  }: {
    board: BoardState;
    onplay: (move: unknown) => void;
    /** Another of this person's devices is mid-move. There is no staging step
     *  here — a tap is the whole move — so this only ever greys the grid. */
    locked?: boolean;
  } = $props();

  const marks = ['✕', '○'];

  const cells = $derived((board.view.board ?? []) as (number | null)[]);
  const legal = $derived(new Set((board.view.legalMoves ?? []) as number[]));
  const winning = $derived(new Set((board.view.winningLine ?? []) as number[]));
  const yourTurn = $derived(Boolean(board.view.yourTurn) && !board.outcome);
</script>

<div class="board" class:done={Boolean(board.outcome) || locked}>
  {#each cells as mark, cell (cell)}
    <button
      class="cell"
      class:won={winning.has(cell)}
      disabled={!yourTurn || locked || !legal.has(cell)}
      aria-label={mark === null ? `Play cell ${cell + 1}` : `Cell ${cell + 1}, ${marks[mark]}`}
      onclick={() => onplay({ cell })}
    >
      {mark === null ? '' : marks[mark]}
    </button>
  {/each}
</div>

<style>
  .board {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.4rem;
    margin-block: 1rem;
  }

  .cell {
    aspect-ratio: 1;
    font-size: clamp(1.8rem, 12vw, 3rem);
    line-height: 1;
    display: grid;
    place-items: center;
    background: var(--surface);
    padding: 0;
  }

  .cell:disabled {
    opacity: 1;
  }

  /* An empty cell only looks pressable when it actually is. */
  .cell:not(:disabled):hover {
    background: var(--accent-soft);
  }

  .cell.won {
    background: var(--accent-soft);
    border-color: var(--accent);
  }

  .done .cell {
    cursor: default;
  }
</style>
