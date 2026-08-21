/**
 * Links that arrive from outside, and the browser they land in.
 *
 * A link is opened wherever the operating system decides to open it, and on iOS
 * that is never the installed app: a Home Screen web app has its own storage
 * container, separate from Safari's, and there is no URL, scheme, or manifest
 * key that reaches it. Tapping a link or scanning a QR code opens Safari — same
 * origin, same app, and as far as the data is concerned a different device. An
 * in-app browser inside a messaging app is a third container again.
 *
 * That would be a nuisance if links were repeatable. They are not. An invite is
 * a single-use bearer token and a device link is a one-shot bundle, and both
 * are spent by the act of opening them. Spending one in a container the
 * installed app cannot see does not merely open the game in the wrong window:
 * it consumes the link, generates an identity nobody asked for, and leaves the
 * person to ask their friend for another — with no way to tell that is what
 * happened, because the wrong window looks exactly like the right one.
 *
 * So nothing irreversible happens until we know which storage we are in. Where
 * the platform can route a link itself we ask it to, in the manifest:
 * `handle_links: preferred` offers in-scope links to the installed app, and
 * `launch_handler.navigate-existing` sends them to the window already open
 * rather than a second one. Chromium honours both, which settles Android and
 * the desktop, where a tab and the installed app share storage anyway. iOS
 * honours neither and never will, so there the link is carried across by hand:
 * the person is asked, once, before anything is spent.
 */
import { parseInviteFragment } from './games.ts';
import { isIos, isStandalone } from './lifecycle.ts';
import { parseLinkWords } from './link.ts';

/**
 * Whether opening a link here would spend it outside the installed app.
 *
 * True on iOS in a tab, which covers Safari and every in-app browser, since
 * none of them can reach the Home Screen app's storage. False everywhere the
 * question does not arise: installed already, or a platform whose browser and
 * installed app share one storage container.
 *
 * Deliberately a guess about the *platform*, not about whether this particular
 * person has installed anything — that cannot be known from inside the wrong
 * container, and is why the answer has to come from them.
 */
export function opensOutsideTheApp(): boolean {
  return isIos() && !isStandalone();
}

/** The two kinds of link tabla hands out, and where each one is redeemed. */
export interface SharedLink {
  kind: 'invite' | 'device';
  /** Where to go to redeem it, secret and all. */
  to: string;
}

/**
 * Recognises a link that has been carried across by hand.
 *
 * Whatever survives the trip is accepted: the whole URL, which is what a copy
 * gives; the fragment alone, which is what is left after an over-eager chat app
 * has eaten the rest; or six words, which is what a device link sounds like
 * when it was read out rather than sent. The secret is in the fragment either
 * way, so this is also the reason a link can be handed over at all — the part
 * that matters never went to a server and does not need to.
 */
export function parseSharedLink(input: string): SharedLink | null {
  const text = input.trim();
  if (!text) return null;

  const url = asUrl(text);
  const body = fragmentOf(url ? url.hash : text);
  // A pasted URL says which kind of link it is. Anything else has to be known
  // by its shape, because "harbor linen quartz meadow copper sable" is a link
  // too, and arrived without one.
  const path = url ? url.pathname.replace(/\/+$/, '') : null;

  if (path === null || path === '/j') {
    if (parseInviteFragment(body)) return { kind: 'invite', to: `/j#${body}` };
  }

  if (path === null || path === '/link') {
    const words = parseLinkWords(body.replace(/-/g, ' '));
    if (words) return { kind: 'device', to: `/link#${words.join('-')}` };
  }

  return null;
}

/**
 * The six words a device link carries, for the field that wants them.
 *
 * A scan and a paste and a typed line all end here, which is the point: the
 * camera decodes, and this decides. Returns null for anything that is not a
 * device link — a stray code the camera happened to catch is not an error, it
 * is a frame to keep scanning past.
 */
export function linkWordsFrom(input: string): string | null {
  const link = parseSharedLink(input);
  if (link?.kind !== 'device') return null;
  return link.to.split('#')[1].replace(/-/g, ' ');
}

/** Only a real web URL counts; anything else is treated as a bare fragment. */
function asUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The part after the `#`, decoded, having survived whoever forwarded it. */
function fragmentOf(text: string): string {
  const raw = text.replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    // A stray `%` in a pasted string is not worth failing over: the parsers
    // below will reject it on its own merits if it is not a link.
    return raw;
  }
}
