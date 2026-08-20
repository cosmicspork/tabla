/**
 * Light, dark, or whatever the device says.
 *
 * The palette lives in `app.css`; this only decides which of its two halves
 * applies, by putting `data-theme` on the root element — or removing it, which
 * hands the decision back to the device.
 */
import { getMeta, setMeta } from './db/store.ts';

export type ThemeChoice = 'system' | 'light' | 'dark';

const THEME_KEY = 'theme';

/**
 * The colour the browser paints around the page — the address bar on Android,
 * the status area of an installed app. Mirrors `--bg` in `app.css`; if the
 * palette moves there, move it here in the same commit.
 */
const BACKGROUND = { light: '#fbfaf8', dark: '#171614' } as const;

export async function loadTheme(): Promise<ThemeChoice> {
  return (await getMeta<ThemeChoice>(THEME_KEY)) ?? 'system';
}

export async function setTheme(choice: ThemeChoice): Promise<void> {
  await setMeta(THEME_KEY, choice);
  applyTheme(choice);
}

/**
 * Puts the choice on the document.
 *
 * `system` removes the attribute rather than computing what the device would
 * have said, so the page keeps following it if it changes while the app is
 * open.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;

  // A single theme-color tag cannot follow the device on its own, so when the
  // choice is `system` we work out what the device currently says and set that.
  const dark =
    choice === 'dark' ||
    (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  meta.content = dark ? BACKGROUND.dark : BACKGROUND.light;
}
