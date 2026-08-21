<script lang="ts">
  /**
   * The settings hub.
   *
   * One row per thing a person controls, in the order they are likely to want
   * them: who I am, who I play, whether I am told, how it looks, and then the
   * rare and the merely informative. Each summary is read from the thing it
   * describes, so the hub answers most questions without being opened.
   */
  import HubRow from '$lib/components/HubRow.svelte';
  import { GLYPHS } from '$lib/components/SettingsGlyphs.ts';
  import { getMeta, listContacts, listDevices } from '$lib/db/store.ts';
  import { thisDevice } from '$lib/devices.ts';
  import { displayName } from '$lib/profile.ts';
  import { fingerprint, myPublicKey } from '$lib/identity.ts';
  import { pageTitle } from '$lib/page-title.svelte.ts';
  import { pushAvailability, type PushAvailability } from '$lib/push.ts';
  import { storedBytesForGame } from '$lib/plugin/install.ts';
  import { allGames } from '$lib/registry.ts';
  import { loadTheme, type ThemeChoice } from '$lib/theme.ts';

  let key = $state('');
  let name = $state('');
  let contacts = $state<string[]>([]);
  let devices = $state<{ id: string; name: string }[]>([]);
  let myDevice = $state('');
  let availability = $state<PushAvailability | null>(null);
  let theme = $state<ThemeChoice>('system');
  let lastBackup = $state<number | undefined>(undefined);
  let stored = $state(0);

  $effect(() => {
    pageTitle.text = 'Settings';
  });

  $effect(() => {
    void (async () => {
      key = await myPublicKey();
      name = await displayName();
      contacts = (await listContacts()).map((contact) => contact.name);
      myDevice = (await thisDevice()).id;
      devices = await listDevices();
      availability = await pushAvailability();
      theme = await loadTheme();
      lastBackup = await getMeta<number>('lastBackupAt');
      stored = await storedBytes();
    })();
  });

  /** How much of this device the downloaded games are using, in total. */
  async function storedBytes(): Promise<number> {
    const downloadable = allGames().filter((entry) => entry.distribution === 'downloadable');
    const byGame = new Map<string, number[]>();
    for (const entry of downloadable) {
      byGame.set(entry.id, [...(byGame.get(entry.id) ?? []), entry.version]);
    }

    const sizes = await Promise.all(
      [...byGame.entries()].map(([id, versions]) =>
        storedBytesForGame(id, versions).catch(() => 0),
      ),
    );
    return sizes.reduce((total, size) => total + size, 0);
  }

  const profileSummary = $derived(
    key ? `${name || 'No name yet'} · ${fingerprint(key)}…` : 'Your name and fingerprint',
  );

  const devicesSummary = $derived.by(() => {
    const others = devices.filter((device) => device.id !== myDevice);
    if (others.length === 0) return 'Just this one';
    if (others.length === 1) return `This one and ${others[0].name}`;
    return `This one and ${others.length} others`;
  });

  const peopleSummary = $derived(
    contacts.length === 0
      ? 'Nobody yet — they are added after a game'
      : `${contacts.slice(0, 3).join(', ')}${contacts.length > 3 ? `, and ${contacts.length - 3} more` : ''}`,
  );

  const notificationsSummary = $derived.by(() => {
    switch (availability) {
      case 'enabled':
        return 'On, for this device';
      case 'available':
        return 'Off';
      case 'needs-install':
        return 'Add tabla to your Home Screen first';
      case 'denied':
        return 'Blocked for this site';
      case 'unsupported':
        return 'Not available in this browser';
      default:
        return 'Checking…';
    }
  });

  const themeSummary = $derived(
    theme === 'system' ? 'Follows your device' : theme === 'dark' ? 'Dark' : 'Light',
  );

  const backupSummary = $derived(
    lastBackup === undefined
      ? 'Never backed up'
      : `Last backup ${new Date(lastBackup).toLocaleDateString()}`,
  );

  const storageSummary = $derived(
    stored === 0
      ? 'Nothing downloaded yet'
      : `${Math.round(stored / 100_000) / 10} MB of downloaded games`,
  );
</script>

<div class="hub">
  <HubRow
    href="/settings/profile"
    title="Profile"
    summary={profileSummary}
    glyph={GLYPHS.profile}
  />
  <HubRow
    href="/settings/devices"
    title="Devices"
    summary={devicesSummary}
    glyph={GLYPHS.devices}
  />
  <HubRow href="/settings/people" title="People" summary={peopleSummary} glyph={GLYPHS.people} />
  <HubRow
    href="/settings/notifications"
    title="Notifications"
    summary={notificationsSummary}
    glyph={GLYPHS.notifications}
  />
  <HubRow
    href="/settings/appearance"
    title="Appearance"
    summary={themeSummary}
    glyph={GLYPHS.appearance}
  />
  <HubRow
    href="/settings/backup"
    title="Backup &amp; restore"
    summary={backupSummary}
    glyph={GLYPHS.backup}
  />
  <HubRow
    href="/settings/storage"
    title="Storage"
    summary={storageSummary}
    glyph={GLYPHS.storage}
  />
  <HubRow
    href="/settings/about"
    title="About"
    summary="Version, and what the relay knows"
    glyph={GLYPHS.about}
  />
</div>
