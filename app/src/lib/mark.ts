/**
 * The tabla mark: a single Letras tile, lettered `t`, worth two points.
 *
 * Geometry rather than traced path data, so the in-app mark
 * (`components/Mark.svelte`) and the generated app icons come from one
 * definition and cannot drift. The letter is drawn rather than typeset because
 * an icon that depends on a font is an icon that renders differently wherever
 * the font is missing.
 */

/** Every coordinate below is in this square. */
export const VIEW_BOX = 512;

/** Rounded corner of the app-icon plate, in viewBox units (21.9% of 512). */
export const PLATE_RADIUS = 112;

function round(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

/**
 * The letterform, as one closed path.
 *
 * A geometric lowercase `t`: an ascender, a crossbar, and a foot that turns
 * right. Drawn clockwise from the top-left of the ascender.
 */
function letter(dx: number, dy: number, scale: number): string {
  const x = (value: number) => round(value * scale + dx);
  const y = (value: number) => round(value * scale + dy);

  // Stem, crossbar, and foot, in untranslated units.
  const stemL = 196;
  const stemR = 266;
  const top = 84;
  const barTop = 168;
  const barBottom = 238;
  const barL = 128;
  const barR = 334;
  // Where the stem stops being straight and the foot begins.
  const footTurn = 322;
  const footTop = 382;
  const footBottom = 452;
  const footR = 366;

  return [
    `M${x(stemL)} ${y(top)}`,
    `L${x(stemR)} ${y(top)}`,
    `L${x(stemR)} ${y(barTop)}`,
    `L${x(barR)} ${y(barTop)}`,
    `L${x(barR)} ${y(barBottom)}`,
    `L${x(stemR)} ${y(barBottom)}`,
    `L${x(stemR)} ${y(footTurn)}`,
    // The foot: out of the stem and to the right, on a quarter turn.
    `C${x(stemR)} ${y(362)} ${x(286)} ${y(footTop)} ${x(footTurn)} ${y(footTop)}`,
    `L${x(footR)} ${y(footTop)}`,
    `L${x(footR)} ${y(footBottom)}`,
    `L${x(316)} ${y(footBottom)}`,
    // And back up the inside of the same turn, which is tighter than the
    // outside by exactly the stroke width — that is what makes it a curve
    // rather than a bent stick.
    `C${x(236)} ${y(footBottom)} ${x(stemL)} ${y(408)} ${x(stemL)} ${y(326)}`,
    `L${x(stemL)} ${y(barBottom)}`,
    `L${x(barL)} ${y(barBottom)}`,
    `L${x(barL)} ${y(barTop)}`,
    `L${x(stemL)} ${y(barTop)}`,
    'Z',
  ].join('');
}

/**
 * The point value, as one closed path.
 *
 * Two points is what a `t` is worth in this game, and a tile without its number
 * is not a tile. It is the detail nobody has to notice.
 */
function pip(dx: number, dy: number, scale: number): string {
  const x = (value: number) => round(value * scale + dx);
  const y = (value: number) => round(value * scale + dy);

  return [
    `M${x(26)} ${y(40)}`,
    `C${x(26)} ${y(16)} ${x(44)} ${y(0)} ${x(66)} ${y(0)}`,
    `C${x(90)} ${y(0)} ${x(106)} ${y(16)} ${x(106)} ${y(38)}`,
    `C${x(106)} ${y(56)} ${x(94)} ${y(72)} ${x(72)} ${y(90)}`,
    `L${x(48)} ${y(110)}`,
    `L${x(108)} ${y(110)}`,
    `L${x(108)} ${y(140)}`,
    `L${x(22)} ${y(140)}`,
    `L${x(22)} ${y(112)}`,
    `L${x(58)} ${y(78)}`,
    `C${x(74)} ${y(62)} ${x(80)} ${y(52)} ${x(80)} ${y(40)}`,
    `C${x(80)} ${y(28)} ${x(74)} ${y(22)} ${x(65)} ${y(22)}`,
    `C${x(55)} ${y(22)} ${x(50)} ${y(30)} ${x(50)} ${y(42)}`,
    `L${x(50)} ${y(46)}`,
    `L${x(26)} ${y(46)}`,
    'Z',
  ].join('');
}

/**
 * The whole mark, as a single `d` for one filled path.
 *
 * The small tier is not the large one scaled down: below about 32 pixels the
 * point value closes up into a smudge, so it goes, and the letter grows into
 * the room it leaves. Same tile, read from further away.
 */
export function tileMark(small = false): string {
  if (small) return letter(-28, -48, 1.15);
  return `${letter(-6, -26, 0.98)} ${pip(330, 322, 1)}`;
}
