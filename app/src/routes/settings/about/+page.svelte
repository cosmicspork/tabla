<script lang="ts">
  /**
   * What this build is, and what it is trusting.
   *
   * The versions matter here in a way they do not in most apps: a game is
   * played under the exact rules both devices agreed to, and the word list is
   * pinned by hash in the invite. Being able to read those numbers off the
   * screen is what makes "we are playing the same game" checkable rather than
   * assumed.
   */
  import { version } from '$app/environment';

  import { listDevices } from '$lib/db/store.ts';
  import { thisDevice } from '$lib/devices.ts';
  import { DICTIONARY_EN_V1 } from '@tabla/shared';

  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { allGames } from '$lib/registry.ts';

  $effect(() => {
    pageTitle.text = 'About';
  });

  /**
   * One line per game rather than one per version: two versions of Letras are
   * two sets of rules under one name, and listing them as siblings reads as
   * two games.
   */
  const rules = [
    ...allGames()
      .reduce((byGame, entry) => {
        byGame.set(entry.title, [...(byGame.get(entry.title) ?? []), entry.version]);
        return byGame;
      }, new Map<string, number[]>())
      .entries(),
  ]
    .map(
      ([title, versions]) =>
        `${title} ${versions
          .sort()
          .map((v) => `v${v}`)
          .join(', ')}`,
    )
    .join(' · ');

  let relay = $state('');
  let deviceLine = $state('This one');

  $effect(() => {
    relay = location.host;
  });

  $effect(() => {
    void (async () => {
      const me = await thisDevice();
      const all = await listDevices();
      const at = all.findIndex((device) => device.id === me.id) + 1;
      deviceLine = all.length <= 1 ? me.name : `${me.name} · ${at} of ${all.length} linked`;
    })();
  });
</script>

<div class="stack">
  <section class="card">
    <p class="tagline">Ad-free, private, asynchronous games with people you know.</p>
    <p class="muted creed">the relay never sees a move · no accounts · nothing to look you up by</p>

    <dl class="facts">
      <div class="fact">
        <dt>App version</dt>
        <dd class="mono" data-testid="app-version">{version}</dd>
      </div>
      <div class="fact">
        <dt>This device <small>all of them play as the same person</small></dt>
        <dd data-testid="device-count">{deviceLine}</dd>
      </div>
      <div class="fact">
        <dt>Rules carried <small>a game keeps the ones it started with</small></dt>
        <dd>{rules}</dd>
      </div>
      <div class="fact">
        <dt>Word list <small>pinned by hash in every game that reads it</small></dt>
        <dd class="mono small">{DICTIONARY_EN_V1.sha256.slice(0, 16)}…</dd>
      </div>
      <div class="fact">
        <dt>Relay <small>transports and stores, never reads</small></dt>
        <dd class="mono small">{relay}</dd>
      </div>
    </dl>
  </section>

  <section class="card">
    <h2>What the relay knows</h2>
    <p class="muted">
      That two devices are exchanging sealed blobs, how large they are, and when. Not the game, not
      the moves, not the result, not your name — none of which it could read if it wanted to. The
      keys never leave the two phones playing.
    </p>
  </section>

  <section class="card">
    <h2>Source</h2>
    <p class="muted">
      Everything above is checkable:
      <a href="https://github.com/cosmicspork/tabla">github.com/cosmicspork/tabla</a>.
    </p>
  </section>
</div>

<style>
  .tagline {
    margin: 0 0 0.25rem;
  }

  .creed {
    font-size: 0.8rem;
    margin: 0 0 0.5rem;
  }

  .small {
    font-size: 0.75rem;
  }
</style>
