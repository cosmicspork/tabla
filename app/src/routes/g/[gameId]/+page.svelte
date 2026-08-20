<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import type { Component } from 'svelte';

  import InviteShare from '$lib/components/InviteShare.svelte';
  import NotifyPrompt from '$lib/components/NotifyPrompt.svelte';
  import StatusBanner from '$lib/components/StatusBanner.svelte';
  import { getGame } from '$lib/db/store.ts';
  import type { GameRecord } from '$lib/db/schema.ts';
  import { GameSession, type BoardState } from '$lib/game-session.ts';
  import { cancelPendingGame, refreshPendingGame } from '$lib/games.ts';
  import { onShouldResync } from '$lib/lifecycle.ts';
  import { currentSubscription } from '$lib/push.ts';
  import { installPlugin, installedState, InstallError } from '$lib/plugin/install.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { gameEntry, titleOf, type BoardProps } from '$lib/registry.ts';
  import type { PushSubscriptionJson } from '@tabla/shared';

  const gameId = $derived(decodeURIComponent(page.params.gameId ?? ''));

  let game = $state<GameRecord | null>(null);
  let session = $state<GameSession | null>(null);
  let board = $state<BoardState | null>(null);
  let Board = $state<Component<BoardProps> | null>(null);
  let failure = $state<string | null>(null);
  let downloading = $state<{ title: string; bytes: number } | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The header names the screen.
   *
   * An unredeemed invite is not yet a game of anything — it is an invitation,
   * and calling it by the game's name would say the game had started. The name
   * arrives with the opponent, which is also what makes the header a reliable
   * signal that it did.
   */
  $effect(() => {
    if (!game) pageTitle.text = 'Game';
    else if (game.status === 'pending' || game.status === 'expired') pageTitle.text = 'Invitation';
    else pageTitle.text = titleOf(game.pluginId);
  });

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
      // By version: a game in progress keeps the rules it started with, and
      // this build may carry several.
      const entry = gameEntry(record.pluginId, record.pluginVersion);
      if (entry) Board = (await entry.board()).default;

      // Rules for a game the app does not carry are fetched and checked before
      // the board opens, so a player waits once, here, with an explanation —
      // rather than watching an empty board and wondering.
      if (entry?.distribution === 'downloadable')
        await download(entry.id, entry.version, entry.title);

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
      failure = describe(error);
    }
  }

  function describe(error: unknown): string {
    if (error instanceof InstallError) {
      switch (error.kind) {
        case 'offline':
          return 'This game needs a one-time download and there is no connection. It plays offline once it has been downloaded.';
        case 'tampered':
        case 'corrupt':
          return 'This copy of tabla failed its own integrity check, so it will not load the game. Reinstalling the app should fix it.';
        default:
          return 'This version of tabla does not have this game.';
      }
    }

    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Fetches a game's rules, saying so while it happens.
   *
   * Only the first time on a device: they are kept afterwards, and survive
   * both app updates and going offline. A failure here is worth naming
   * precisely, because "come back when you have a signal" and "this copy of
   * tabla is not intact" call for very different things from a player.
   */
  async function download(pluginId: string, version: number, title: string) {
    const state = await installedState(pluginId, version).catch(() => null);
    if (state?.installed) return;

    downloading = { title, bytes: state?.totalBytes ?? 0 };
    try {
      await installPlugin(pluginId, version);
    } finally {
      downloading = null;
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

  async function cancelInvite() {
    if (!confirm('Call off this invite? The link will stop working for you either way.')) return;
    try {
      await cancelPendingGame(gameId);
      await goto('/');
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  /** Whether this game's board puts resigning in its own action row. */
  const resignInBoard = $derived(
    Boolean(game && gameEntry(game.pluginId, game.pluginVersion)?.resignInBoard),
  );

  const statusLine = $derived.by(() => {
    if (!board) return '';
    if (board.outcome) {
      if (board.resignedBy !== undefined) {
        return board.resignedBy === board.player ? 'You resigned.' : 'They resigned.';
      }
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

{#if failure}
  <p class="notice warn">{failure}</p>
{/if}

{#if game?.status === 'pending'}
  <StatusBanner text="Waiting for someone to join" detail={titleOf(game.pluginId)} spinner />
  {#if game.blobKey}
    <InviteShare link={`${location.origin}/j#${game.blobId}.${game.blobKey}`} />
  {/if}
  <button class="ghost danger" onclick={cancelInvite}>Cancel invite</button>
{:else if game?.status === 'expired'}
  <StatusBanner text="Nobody took this invite" tone="warn" />
  <p class="muted">Invites last seven days. Start another game to send a fresh link.</p>
  <button class="ghost danger" onclick={cancelInvite}>Remove</button>
{:else if game?.status === 'incompatible'}
  <StatusBanner text="This game needs a newer tabla" tone="warn" />
  <p class="muted">
    This game needs a different version of the rules than this build has. Playing anyway would mean
    the two of you disagreeing about legal moves partway through, which cannot be repaired — so it
    is refused up front.
  </p>
{:else if board?.ready && Board}
  <StatusBanner
    text={statusLine}
    detail={board.opponentPresent && !board.outcome ? 'They are here' : ''}
    tone={board.outcome ? 'warn' : 'info'}
  />

  <Board {board} {onplay} onresign={resign} />

  {#if connection}
    <p class="notice">{connection}</p>
  {/if}

  {#if !board.outcome && !resignInBoard}
    <button class="danger" onclick={resign}>Resign</button>
  {/if}

  <div class="notify">
    <NotifyPrompt
      onsubscribe={(subscription: PushSubscriptionJson) => session?.subscribeToPush(subscription)}
    />
  </div>
{:else if downloading}
  <StatusBanner text="Getting {downloading.title}…" spinner />
  <p class="muted">
    {#if downloading.bytes > 0}
      A one-time download of about {Math.round(downloading.bytes / 100_000) / 10} MB.
    {:else}
      A one-time download.
    {/if}
    It is kept on this device afterwards, so the game plays offline from here on.
  </p>
{:else if board && !board.ready}
  <StatusBanner text="Setting up…" spinner />
  <p class="muted">Waiting for the opening entries to reach both devices.</p>
{:else if !failure}
  <StatusBanner text="Loading…" spinner />
{/if}

<style>
  .notify {
    margin-top: 2rem;
  }

  .ghost {
    background: none;
    border: none;
    font-size: 0.9rem;
    padding: 0.25rem;
  }
</style>
