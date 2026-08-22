<script lang="ts">
  import type { BoardState } from '$lib/game-session.ts';

  let {
    board,
    onplay,
    onresign,
    onstage,
    locked = false,
  }: {
    board: BoardState;
    onplay: (move: unknown) => void | Promise<boolean | void>;
    onresign?: () => void;
    onstage?: (staged: boolean) => void;
    locked?: boolean;
  } = $props();

  const SIZE = 15;

  /**
   * The rules hand the board and the premium layout over as one character per
   * square, which keeps a 225-square grid from becoming a wall of JSON on every
   * render. `.` is empty, a lowercase letter is a tile, an uppercase one is a
   * blank being read as that letter.
   */
  const played = $derived((board.view.board ?? '.'.repeat(225)) as string);
  const premiums = $derived((board.view.premiums ?? '.'.repeat(225)) as string);
  const rack = $derived((board.view.rack ?? '') as string);
  const values = $derived((board.view.values ?? []) as number[]);
  const scores = $derived((board.view.scores ?? [0, 0]) as [number, number]);
  const finalScores = $derived(board.view.finalScores as [number, number] | undefined);
  const you = $derived((board.view.you ?? 0) as number);
  const phase = $derived((board.view.phase ?? 'play') as string);
  const yourTurn = $derived(Boolean(board.view.yourTurn));
  const bag = $derived((board.view.bag ?? 0) as number);
  const opponentTiles = $derived((board.view.opponentTiles ?? 0) as number);
  const canChallenge = $derived(Boolean(board.view.canChallenge));
  const lastPlay = $derived(
    board.view.lastPlay as { by: number; words: string[]; cells: number[]; score: number } | null,
  );
  const audit = $derived(board.view.audit as { ok: boolean[]; notes: (string | null)[] } | null);

  const rackCommitment = $derived(board.view.rackCommitment as number[] | null);
  /**
   * The keystream for our next exchange, from the rules.
   *
   * Which tiles you throw back stays yours until the reveal, so it goes into
   * the log masked. The rules cannot mask it for us — they do not know what we
   * will pick — so they hand over the keystream and we XOR our own choice.
   */
  const exchangeMask = $derived((board.view.exchangeMask ?? []) as number[]);

  /**
   * Where in the deck each rack tile came from, under the current rules.
   *
   * A tile is named by its position when it is played, because that is what
   * the deal understands and what the opening will refer to. Empty under the
   * older rules, which had no deck to point into.
   */
  const rackPositions = $derived((board.view.rackPositions ?? []) as number[]);
  const dealt = $derived(rackPositions.length > 0);

  /** Tiles placed this turn but not yet played: `cell -> rack index`. */
  let pending = $state<Map<number, number>>(new Map());
  /** Which rack tile is picked up, as an index into the rack string. */
  let held = $state<number | null>(null);
  /**
   * The cell holding a blank that has not been told what it stands for.
   *
   * A move cannot be played while this is set, so it has to be impossible to
   * leave behind: every path that takes the blank off the board clears it too,
   * and the question itself is asked in a modal that cannot be scrolled past.
   */
  let assigning = $state<number | null>(null);
  let blankLetters = $state<Map<number, string>>(new Map());
  let chooser = $state<HTMLDialogElement | null>(null);
  let exchanging = $state(false);
  let discards = $state<Set<number>>(new Set());
  let busy = $state(false);

  const usedRackTiles = $derived(new Set(pending.values()));

  /**
   * Tells the page when a move starts and stops being built.
   *
   * Staging the first tile is the moment this device claims the turn from its
   * siblings, and taking them all back is the moment it gives it up. Reading it
   * off the staged tiles rather than firing it from every call site is what
   * keeps the two from drifting.
   */
  let staging = false;
  $effect(() => {
    const now = pending.size > 0;
    if (now === staging) return;
    staging = now;
    onstage?.(now);
  });

  /** Whether a rack tile is spoken for by a tile already on the board. */
  function isUsed(index: number): boolean {
    return usedRackTiles.has(index);
  }

  function letterAt(cell: number): string {
    const staged = pending.get(cell);
    if (staged !== undefined) {
      const tile = rack[staged];
      return tile === '?' ? (blankLetters.get(cell) ?? '?').toUpperCase() : tile;
    }
    return played[cell] === '.' ? '' : played[cell];
  }

  function isBlank(cell: number): boolean {
    const staged = pending.get(cell);
    if (staged !== undefined) return rack[staged] === '?';
    return played[cell] !== '.' && played[cell] === played[cell].toUpperCase();
  }

  function valueOf(letter: string): number {
    if (!letter || letter !== letter.toLowerCase()) return 0;
    return values[letter.charCodeAt(0) - 97] ?? 0;
  }

  function tapCell(cell: number) {
    if (!yourTurn || locked || phase !== 'play' || assigning !== null) return;

    // Tapping a tile you just put down takes it back.
    if (pending.has(cell)) {
      pending.delete(cell);
      blankLetters.delete(cell);
      pending = new Map(pending);
      blankLetters = new Map(blankLetters);
      return;
    }

    if (held === null || played[cell] !== '.') return;

    pending.set(cell, held);
    pending = new Map(pending);
    if (rack[held] === '?') assigning = cell;
    held = null;
  }

  function tapRack(index: number) {
    if (!yourTurn || assigning !== null) return;

    if (exchanging) {
      if (discards.has(index)) discards.delete(index);
      else discards.add(index);
      discards = new Set(discards);
      return;
    }
    held = held === index ? null : index;
  }

  function chooseBlank(letter: string) {
    if (assigning === null) return;
    blankLetters.set(assigning, letter);
    blankLetters = new Map(blankLetters);
    assigning = null;
  }

  /**
   * Changes your mind about the blank, and puts it back on the rack.
   *
   * There has to be a way out of the question: a blank with no letter is not a
   * move, so a chooser that could only be answered would be a corner with
   * nothing in it but Recall. Escape and the backdrop come here too.
   */
  function putBlankBack() {
    if (assigning === null) return;
    pending.delete(assigning);
    pending = new Map(pending);
    assigning = null;
  }

  /**
   * Opens and closes the chooser to follow `assigning`.
   *
   * `showModal` rather than an `{#if}` block: it puts the question in the top
   * layer, where the length of the board cannot push it under the fold, and it
   * takes the taps that would otherwise land on tiles behind it. Both were the
   * bug — the question went unseen, the board still moved under it, and Play
   * refused a move it would not explain.
   */
  $effect(() => {
    const dialog = chooser;
    if (!dialog) return;
    if (assigning !== null) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  });

  function recall() {
    pending = new Map();
    blankLetters = new Map();
    held = null;
    assigning = null;
  }

  /** Turns the staged tiles into the placements the rules expect. */
  function placements() {
    return [...pending.entries()].map(([cell, index]) => ({
      ...(dealt ? { position: rackPositions[index] } : {}),
      row: Math.floor(cell / SIZE),
      col: cell % SIZE,
      tile: rack[index] === '?' ? 0 : rack.charCodeAt(index) - 96,
      blankAs: rack[index] === '?' ? (blankLetters.get(cell) ?? 'e').charCodeAt(0) - 96 : null,
    }));
  }

  /** A staged blank that still has no letter, if one slipped through. */
  function undecidedBlank(): number | null {
    for (const [cell, index] of pending) {
      if (rack[index] === '?' && !blankLetters.has(cell)) return cell;
    }
    return null;
  }

  /**
   * Hands an action to the session, which wraps it in whatever else these
   * rules want carried — a deal payload, or a nonce and a commitment.
   *
   * That bookkeeping lives there rather than here because it differs by
   * version, and a board that had to know would need rewriting for each.
   *
   * The board is only cleared if the move was taken. Now that words are checked
   * as they are played, a refusal is something a player meets in normal play,
   * and sweeping their tiles back to the rack would make them lay the whole word
   * out again to change one letter.
   */
  async function submit(action: unknown) {
    if (busy) return;
    busy = true;
    try {
      if ((await onplay(action)) === false) return;
      recall();
      exchanging = false;
      discards = new Set();
    } finally {
      busy = false;
    }
  }

  function play() {
    if (pending.size === 0 || assigning !== null) return;

    // Rather than send a letter nobody chose. `placements` falls back to an `e`
    // so it always has something to hand the rules, and playing that silently
    // would be worse than asking again.
    const undecided = undecidedBlank();
    if (undecided !== null) {
      assigning = undecided;
      return;
    }

    void submit({ place: { placements: placements() } });
  }

  function pass() {
    void submit('pass');
  }

  function challenge() {
    void submit('challenge');
  }

  function startExchange() {
    recall();
    exchanging = true;
  }

  function confirmExchange() {
    const tiles = [...discards]
      .map((i) => (rack[i] === '?' ? 0 : rack.charCodeAt(i) - 96))
      .sort((a, b) => a - b);
    if (dealt) {
      // Under the current rules the positions go back in the clear: what was
      // in them stays hidden, because they return to a deck nobody can read.
      void submit({ exchange: { returned: [...discards].map((i) => rackPositions[i]) } });
      return;
    }

    const masked = tiles.map((tile, i) => tile ^ (exchangeMask[i] ?? 0));
    void submit({ exchange: { masked } });
  }

  /**
   * What the game is doing while it is not waiting for the player.
   *
   * Key shares, shuffles and dealing are protocol rather than play, and the
   * session submits them on its own. Naming them is worth doing: a shuffle of
   * a hundred tiles takes a moment on a phone, and an unexplained pause reads
   * as something being broken.
   */
  const ceremony = $derived.by(() => {
    if (phase === 'key' || phase === 'shuffle') {
      return yourTurn ? 'Shuffling the bag…' : 'Waiting for your opponent to shuffle…';
    }
    if (phase === 'deal') return yourTurn ? 'Dealing…' : 'Waiting to be dealt…';
    if (phase === 'open') return yourTurn ? 'Opening your rack…' : 'Waiting for their rack…';
    return null;
  });

  const canPlay = $derived(yourTurn && phase === 'play' && pending.size > 0 && assigning === null);
</script>

<div class="letras">
  <div class="scoreline">
    <span class:mine={you === 0}>You {finalScores ? finalScores[you] : scores[you]}</span>
    <span class="muted">{bag} in the bag</span>
    <span>Them {finalScores ? finalScores[1 - you] : scores[1 - you]}</span>
  </div>

  {#if ceremony}
    <p class="ceremony" data-ceremony={phase}>{ceremony}</p>
  {/if}

  <div class="word-board" class:waiting={!yourTurn || locked}>
    {#each Array(225) as _, cell (cell)}
      {@const letter = letterAt(cell)}
      <button
        class="square p{premiums[cell]}"
        class:filled={letter !== ''}
        class:staged={pending.has(cell)}
        class:fresh={lastPlay?.cells?.includes(cell)}
        class:blank={isBlank(cell)}
        onclick={() => tapCell(cell)}
        disabled={!yourTurn || locked || phase !== 'play'}
        aria-label={`row ${Math.floor(cell / SIZE) + 1} column ${(cell % SIZE) + 1}`}
        data-cell={cell}
      >
        {#if letter}
          <span class="letter">{letter.toLowerCase()}</span>
          {#if !isBlank(cell)}<span class="pip">{valueOf(letter.toLowerCase())}</span>{/if}
        {/if}
      </button>
    {/each}
  </div>

  <!-- Clicking the backdrop is a click on the dialog itself, and means the
       same as Escape: put the blank back and carry on. -->
  <dialog
    class="card chooser"
    bind:this={chooser}
    aria-labelledby="blank-question"
    onclose={putBlankBack}
    onclick={(event) => event.target === chooser && putBlankBack()}
  >
    <p id="blank-question">What does the blank stand for?</p>
    <div class="letters">
      {#each 'abcdefghijklmnopqrstuvwxyz'.split('') as letter (letter)}
        <button onclick={() => chooseBlank(letter)}>{letter}</button>
      {/each}
    </div>
    <button class="back" onclick={putBlankBack}>Put it back</button>
  </dialog>

  <div class="rack" data-rack={rack}>
    {#each rack.split('') as tile, index (index)}
      <button
        class="tile"
        class:held={held === index}
        class:spent={isUsed(index)}
        class:discard={discards.has(index)}
        onclick={() => tapRack(index)}
        disabled={!yourTurn || locked || isUsed(index)}
      >
        <span class="letter">{tile === '?' ? ' ' : tile}</span>
        {#if tile !== '?'}<span class="pip">{valueOf(tile)}</span>{/if}
      </button>
    {/each}
  </div>

  {#if exchanging}
    <div class="actions">
      <button
        class="primary"
        onclick={confirmExchange}
        disabled={discards.size === 0 || busy || locked}
      >
        Swap {discards.size}
        {discards.size === 1 ? 'tile' : 'tiles'}
      </button>
      <button onclick={() => ((exchanging = false), (discards = new Set()))}>Cancel</button>
    </div>
  {:else}
    <div class="actions">
      <button class="primary" onclick={play} disabled={!canPlay || busy || locked}>Play</button>
      {#if canChallenge}
        <button class="challenge" onclick={challenge} disabled={busy}>Challenge</button>
      {/if}
      <button onclick={recall} disabled={pending.size === 0}>Recall</button>
      <button
        onclick={startExchange}
        disabled={!yourTurn || locked || phase !== 'play' || bag < 7 || busy}
      >
        Swap
      </button>
      <button onclick={pass} disabled={!yourTurn || locked || phase !== 'play' || busy}>Pass</button
      >
      {#if onresign && !board.outcome}
        <button class="danger resign" onclick={onresign}>Resign</button>
      {/if}
    </div>
  {/if}

  <p class="muted opponent">
    {#if rack.length < 7 && !yourTurn && phase === 'play'}
      You draw when they move
    {:else}
      {opponentTiles} on their rack
    {/if}
  </p>

  {#if lastPlay}
    <p class="muted last">
      {lastPlay.by === you ? 'You played' : 'They played'}
      {lastPlay.words.join(', ')} for {lastPlay.score}.
      {#if canChallenge}
        Challenge it, or take your turn to let it stand.
      {/if}
    </p>
  {/if}

  {#if canChallenge}
    <p class="muted honour">
      This game began under the old rules, where words are not checked as they are played. If you
      think one is not real, challenge it — and lose your turn if it is.
    </p>
  {/if}

  {#if audit}
    <div class="card">
      <h2>End of game check</h2>
      {#each audit.ok as ok, player (player)}
        <p class="muted">
          {player === you ? 'You' : 'They'}: {ok ? 'every draw checks out' : audit.notes[player]}
        </p>
      {/each}
    </div>
  {/if}
</div>

<style>
  .letras {
    display: grid;
    gap: 0.75rem;
  }

  .ceremony {
    text-align: center;
    font-size: 0.9rem;
    opacity: 0.75;
    margin: 0.4rem 0 0;
  }

  .scoreline {
    display: flex;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }

  /* Deliberately not `.board`: that selector belongs to tic tac toe's grid.
   *
   * The height comes from the squares rather than from an aspect-ratio on the
   * grid. Fifteen square rows plus the gaps between them are a little taller
   * than the board is wide, so pinning the box to a square made the bottom row
   * overflow and sit on top of whatever came next — including, memorably, the
   * Play button. */
  .word-board {
    display: grid;
    grid-template-columns: repeat(15, 1fr);
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
  }

  .word-board.waiting {
    opacity: 0.85;
  }

  /* `min-height: 0` matters more than it looks: a grid item defaults to
   * `min-height: auto`, which floors the row at whatever the contents need. A
   * square with a tile in it is then taller than an empty one, the board grows
   * as the game does, and things below it end up in unpredictable places. With
   * the floor removed the aspect ratio decides, and the board is the same size
   * whatever is on it. */
  .square {
    all: unset;
    display: grid;
    place-items: center;
    position: relative;
    aspect-ratio: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    background: var(--bg);
    font-size: clamp(0.45rem, 1.8vw, 0.85rem);
    cursor: pointer;
    line-height: 1;
  }

  .square:disabled {
    cursor: default;
  }

  /* The premium layout, straight from the rules. */
  .square.pd {
    background: color-mix(in srgb, var(--accent) 14%, var(--bg));
  }
  .square.pt {
    background: color-mix(in srgb, var(--accent) 30%, var(--bg));
  }
  .square.pD {
    background: color-mix(in srgb, tomato 18%, var(--bg));
  }
  .square.pT {
    background: color-mix(in srgb, tomato 38%, var(--bg));
  }
  .square.pS {
    background: color-mix(in srgb, tomato 24%, var(--bg));
  }

  .square.filled {
    background: #e8d7b0;
    color: #2b2118;
    font-weight: 600;
  }

  .square.staged {
    background: #f5e9cd;
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .square.fresh {
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  .square.blank .letter {
    font-style: italic;
    opacity: 0.75;
  }

  .pip {
    position: absolute;
    right: 1px;
    bottom: 0;
    font-size: 0.5em;
    opacity: 0.7;
  }

  /* The rack is the one thing on this screen a player reaches for without
     looking, so it sits centred under the board at full width rather than
     tucked against the left edge beside a status line. */
  .rack {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .tile {
    all: unset;
    position: relative;
    display: grid;
    place-items: center;
    width: 2.2rem;
    height: 2.2rem;
    background: #e8d7b0;
    color: #2b2118;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
  }

  .tile.held {
    outline: 2px solid var(--accent);
    transform: translateY(-3px);
  }

  .tile.discard {
    outline: 2px solid tomato;
  }

  .tile.spent {
    opacity: 0.3;
    cursor: default;
  }

  .opponent {
    text-align: center;
    font-size: 0.85rem;
    margin: -0.25rem 0 0;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .actions > button {
    /* Sized to their labels, so all five fit on one line where there is room
       rather than pushing the last one onto a row of its own. */
    flex: 0 1 auto;
  }

  /* Resigning is not one of the moves, so it sits apart from them — at the far
     end of the row, and quieter than the buttons that take a turn. */
  .resign {
    margin-left: auto;
    background: none;
    border-color: transparent;
    padding-inline: 0.4rem;
  }

  .challenge {
    border-color: tomato;
  }

  /* The top layer places it, so this only has to make it look like the rest of
     the app: a dialog draws its own border and takes its colours from the
     browser, which in dark mode means black text on a dark card. */
  .chooser {
    margin: auto;
    max-width: min(24rem, calc(100vw - 2rem));
    color: var(--fg);
    gap: 0.75rem;
  }

  /* Only when it is open. A bare `display` here would beat the browser's own
     `dialog:not([open]) { display: none }`, and the question would sit under
     the board being asked all game. */
  .chooser[open] {
    display: grid;
  }

  .chooser::backdrop {
    background: rgb(0 0 0 / 0.45);
  }

  .chooser p {
    margin: 0;
  }

  .chooser .letters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    justify-content: center;
  }

  .chooser .letters button {
    width: 2rem;
    padding: 0.25rem;
  }

  /* Quieter than the letters, but still plainly a button: it is the way out of
     a question that must be answered, so it cannot read as a caption. */
  .chooser .back {
    justify-self: start;
    color: var(--fg-muted);
    padding: 0.35rem 0.7rem;
  }

  .last,
  .honour {
    font-size: 0.85rem;
    margin: 0;
  }
</style>
