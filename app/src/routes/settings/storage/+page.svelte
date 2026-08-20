<script lang="ts">
  /**
   * What the downloadable games are using, and how to get it back.
   *
   * The old version of this listed one row per *version*, which showed Letras
   * twice under one name and left a person to work out which was which. A game
   * is one row; its versions are detail inside it, because that is what they
   * are — the same game, with rules a game in progress agreed to and cannot be
   * moved off.
   *
   * Nobody should have to come here. Opening a game that needs rules this
   * device does not have downloads them, so removing one costs the download
   * again and nothing else.
   */
  import { listGames } from '$lib/db/store.ts';
  import type { GameRecord } from '$lib/db/schema.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import {
    installedState,
    removePlugin,
    storedBytesForGame,
    type InstalledState,
  } from '$lib/plugin/install.ts';
  import { allGames, type GameEntry } from '$lib/registry.ts';

  interface Version {
    entry: GameEntry;
    state: InstalledState | null;
    /** Games still being played under these rules; they pin this version. */
    inUse: number;
    current: boolean;
  }

  interface Listed {
    id: string;
    title: string;
    versions: Version[];
    bytes: number;
  }

  let games = $state<Listed[]>([]);
  let bundled = $state<GameEntry[]>([]);
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let reclaimed = $state<string | null>(null);

  $effect(() => {
    pageTitle.text = 'Storage';
  });

  $effect(() => {
    void refresh();
  });

  async function refresh() {
    const records = await listGames();
    bundled = allGames().filter((entry) => entry.distribution === 'bundled');

    const downloadable = allGames().filter((entry) => entry.distribution === 'downloadable');
    const byId = new Map<string, Version[]>();

    for (const entry of downloadable) {
      const state = await installedState(entry.id, entry.version).catch(() => null);
      const newest = Math.max(
        ...downloadable.filter((other) => other.id === entry.id).map((other) => other.version),
      );

      byId.set(entry.id, [
        ...(byId.get(entry.id) ?? []),
        { entry, state, inUse: pinnedBy(records, entry), current: entry.version === newest },
      ]);
    }

    games = await Promise.all(
      [...byId.entries()].map(async ([id, versions]) => ({
        id,
        title: versions[0].entry.title,
        versions,
        bytes: await storedBytesForGame(
          id,
          versions.map((version) => version.entry.version),
        ),
      })),
    );

    await sweep();
  }

  /** How many unfinished games are still being played under these exact rules. */
  function pinnedBy(records: GameRecord[], entry: GameEntry): number {
    return records.filter(
      (game) =>
        game.pluginId === entry.id &&
        game.pluginVersion === entry.version &&
        game.status !== 'finished' &&
        game.status !== 'expired',
    ).length;
  }

  /**
   * Removes superseded rules nothing is still playing under.
   *
   * Held onto until the last game that agreed to them is over, and then not
   * worth a decision from anybody — so it happens on its own, and the page says
   * afterwards rather than asking first.
   */
  async function sweep() {
    const stale = games
      .flatMap((game) => game.versions)
      .filter((version) => !version.current && version.inUse === 0 && version.state?.installed);

    if (stale.length === 0) return;

    const freed = stale.reduce((total, version) => total + (version.state?.storedBytes ?? 0), 0);
    for (const version of stale) {
      await removePlugin(version.entry.id, version.entry.version).catch(() => {});
    }

    reclaimed = megabytes(freed);
    await refresh();
  }

  async function remove(version: Version) {
    busy = `${version.entry.id}@${version.entry.version}`;
    failure = null;
    try {
      await removePlugin(version.entry.id, version.entry.version);
      await refresh();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = null;
    }
  }

  function megabytes(bytes: number): string {
    return `${Math.round(bytes / 100_000) / 10} MB`;
  }

  function describe(version: Version): string {
    if (!version.state) return 'unavailable';
    if (!version.state.installed) {
      return version.current
        ? `not downloaded — ${megabytes(version.state.totalBytes)}`
        : 'not on this device';
    }
    if (version.current) return megabytes(version.state.storedBytes);
    return version.inUse === 1
      ? `${megabytes(version.state.storedBytes)} · kept for 1 game still being played`
      : `${megabytes(version.state.storedBytes)} · kept for ${version.inUse} games still being played`;
  }
</script>

<div class="stack">
  <p class="muted intro">
    Games other than tic tac toe are downloaded the first time you play one and checked against a
    signature before they run. Removing one is safe: it comes back the next time you open a game
    that needs it.
  </p>

  {#if failure}
    <p class="notice warn">{failure}</p>
  {/if}

  {#if reclaimed}
    <p class="notice" data-testid="reclaimed">
      Freed {reclaimed} of rules no game was using any more.
    </p>
  {/if}

  {#each games as game (game.id)}
    <section class="card stack" data-plugin={game.id}>
      <div class="setting">
        <span class="label">
          <b>{game.title}</b>
          <small data-size={game.bytes}>
            {game.bytes > 0 ? `${megabytes(game.bytes)} on this device` : 'Not downloaded'}
          </small>
        </span>
        {#each game.versions.filter((version) => version.current && version.state?.installed) as version (version.entry.version)}
          <button disabled={busy !== null} onclick={() => remove(version)}> Remove </button>
        {/each}
      </div>

      {#if game.versions.length > 1}
        <dl class="facts">
          {#each game.versions as version (version.entry.version)}
            <div class="fact" data-version={version.entry.version}>
              <dt>
                {version.current ? 'Current rules' : 'Older rules'}
                <small>version {version.entry.version}</small>
              </dt>
              <dd class="muted">{describe(version)}</dd>
            </div>
          {/each}
        </dl>
        <p class="muted note">
          A game keeps the rules it started under, so an older version stays until the last game
          using it is finished — then it is removed on its own.
        </p>
      {/if}
    </section>
  {/each}

  {#each bundled as entry (entry.id)}
    <section class="card">
      <div class="setting">
        <span class="label">
          <b>{entry.title}</b>
          <small>Built in · always available, with or without a connection</small>
        </span>
      </div>
    </section>
  {/each}
</div>

<style>
  .intro {
    margin: 0;
    font-size: 0.9rem;
  }

  .note {
    margin: 0;
    font-size: 0.8rem;
  }
</style>
