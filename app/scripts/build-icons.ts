/**
 * Generates every app-icon asset from the one geometry definition in
 * `src/lib/mark.ts`: the SVG masters, plus the PNGs the web manifest and iOS
 * actually load. Run from `app/`:
 *
 *   bun run icons
 *
 * Regeneration is deliberate and the outputs are committed, like the compiled
 * word list and unlike anything in `build`: CI installs no browser for the web
 * job, and the mark changes about once a year, so re-deriving byte-identical
 * files on every build would be waste.
 *
 * Rasterisation goes through Playwright because it is already a devDependency
 * — the README screenshots are made the same way — which keeps a whole native
 * image toolchain out of the tree for the sake of four files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { markBounds, PLATE_RADIUS, tileMark, VIEW_BOX } from '../src/lib/mark.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(SCRIPT_DIR, '..', 'static');
const ICONS_DIR = join(STATIC_DIR, 'icons');

// Mirrors --accent and --bg in src/app.css. Duplicated rather than imported
// because a build script cannot read CSS custom properties; if the palette
// moves there, move it here in the same commit.
const PLATE_LIGHT = '#2f6f57';
const INK_LIGHT = '#fbfaf8';
const PLATE_DARK = '#171614';
const INK_DARK = '#6bbf98';

interface SvgOptions {
  /** Maskable icons bleed to the edge: the launcher supplies the mask. */
  bleed?: boolean;
  /** Rendered width and height. The viewBox is always VIEW_BOX. */
  size?: number;
  /** Follow the reader's colour scheme rather than baking the light palette. */
  themeAware?: boolean;
  /** The small tier: no point value, a heavier letter. */
  small?: boolean;
}

/**
 * Android's maskable safe zone: a circle of radius 40% of the icon, centred.
 * Anything outside it may be cropped away by whatever shape the launcher uses.
 */
const SAFE_RADIUS = VIEW_BOX * 0.4;

/**
 * Fits the mark inside the safe circle, for maskable icons only.
 *
 * The mark fills its square deliberately, which is right when the plate's own
 * corners are the boundary and wrong when a launcher is about to cut a circle
 * out of it — the point value sits far enough into the corner to be shaved off.
 * So the maskable variant is scaled about its own centre until its furthest
 * corner is inside the circle.
 */
function safeAreaTransform(small: boolean): string {
  const { minX, minY, maxX, maxY } = markBounds(small);
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;

  const halfDiagonal = Math.hypot((maxX - minX) / 2, (maxY - minY) / 2);
  const scale = Math.min(1, SAFE_RADIUS / halfDiagonal);

  const half = VIEW_BOX / 2;
  return `translate(${half} ${half}) scale(${scale.toFixed(4)}) translate(${-centreX} ${-centreY})`;
}

function svg({ bleed = false, size = VIEW_BOX, themeAware = false, small = false }: SvgOptions) {
  const plate = themeAware ? 'var(--plate)' : PLATE_LIGHT;
  const ink = themeAware ? 'var(--ink)' : INK_LIGHT;

  // `:root` matches the <svg> element in a standalone SVG document, which is
  // how a favicon is loaded — so this tracks the browser chrome's setting.
  const theme = themeAware
    ? `\n  <style>\n    :root { --plate: ${PLATE_LIGHT}; --ink: ${INK_LIGHT}; }\n` +
      `    @media (prefers-color-scheme: dark) {\n` +
      `      :root { --plate: ${PLATE_DARK}; --ink: ${INK_DARK}; }\n    }\n  </style>`
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_BOX} ${VIEW_BOX}"` +
    ` width="${size}" height="${size}">${theme}\n` +
    `  <rect width="${VIEW_BOX}" height="${VIEW_BOX}"${bleed ? '' : ` rx="${PLATE_RADIUS}"`} fill="${plate}"/>\n` +
    (bleed
      ? `  <g transform="${safeAreaTransform(small)}"><path d="${tileMark(small)}" fill="${ink}"/></g>\n`
      : `  <path d="${tileMark(small)}" fill="${ink}"/>\n`) +
    `</svg>\n`
  );
}

const SVGS = [
  { path: join(ICONS_DIR, 'icon.svg'), body: svg({}) },
  { path: join(ICONS_DIR, 'icon-maskable.svg'), body: svg({ bleed: true }) },
  // The only asset a browser re-renders, so the only one that can follow the
  // reader's theme.
  { path: join(STATIC_DIR, 'favicon.svg'), body: svg({ size: 32, themeAware: true, small: true }) },
];

// Every PNG bakes the light plate: a launcher or a springboard never asks an
// icon to re-render for dark mode.
const PNGS = [
  { out: 'apple-touch-icon.png', size: 180, bleed: false },
  { out: 'icon-192.png', size: 192, bleed: false },
  { out: 'icon-512.png', size: 512, bleed: false },
  { out: 'icon-maskable-512.png', size: 512, bleed: true },
];

mkdirSync(ICONS_DIR, { recursive: true });
for (const { path, body } of SVGS) {
  writeFileSync(path, body);
  console.log(`icons: wrote ${path}`);
}

const browser = await chromium.launch();
try {
  for (const { out, size, bleed } of PNGS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    // Inline rather than navigating to the .svg: a standalone SVG document is
    // laid out at its intrinsic size, so it would not scale to the viewport.
    await page.setContent(
      `<style>html,body{margin:0;padding:0;overflow:hidden}</style>` + svg({ bleed, size }),
    );
    const path = join(ICONS_DIR, out);
    await page.screenshot({ path, omitBackground: false });
    await page.close();
    console.log(`icons: wrote ${path} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
