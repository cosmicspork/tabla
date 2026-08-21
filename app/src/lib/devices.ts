/**
 * Keeping this person's devices in step with each other.
 *
 * Every device holds the same identity, so to an opponent and to the relay
 * there is one player — see `tabla_core::device` for why subkeys would buy
 * nothing here. What devices need is a way to tell *each other* what has
 * happened: a game started, an invitation withdrawn, a contact renamed, a
 * device removed.
 *
 * Each device has its own mailbox, and a device that learns something posts a
 * copy to each of the others. One shared box would have every device reading
 * its own writes and racing the others to consume them.
 *
 * Everything here is best-effort by design. A notice that does not send is a
 * device that finds out later — on its next poll, or from the game itself —
 * and never a reason to fail the thing the person actually asked for.
 */
import { fromBase64Url, toBase64Url } from '@tabla/shared';

import { gameFromJson, gameToJson } from './backup.ts';
import type { GameJson } from './backup.ts';
import {
  deleteDevice,
  deleteGame,
  getDevice,
  getGame,
  getMeta,
  listDevices,
  putDevice,
  putGame,
  rememberContact,
  renameContact,
  setMeta,
} from './db/store.ts';
import type { DeviceRecord, GameRecord } from './db/schema.ts';
import { loadIdentity, randomBytes } from './identity.ts';
import { deleteMailboxMessage, pollMailboxes, postMailbox } from './relay.ts';
import { cleanName, setDisplayName } from './profile.ts';
import { REMOVED_BY, removed } from './removed.svelte.ts';

const DEVICE_ID = 'deviceId';
const DEVICE_NAME = 'deviceName';

/** What a device is called before anyone gives it a better idea. */
export const DEFAULT_DEVICE_NAME = 'This device';

/** Mirrors `tabla_core::device::NoticeBody`. Serde writes the variant as a key. */
export type NoticeBody =
  | { GameKnown: GameJson }
  | { GameGone: { game_id: number[] } }
  | { ContactKnown: { public_key: number[]; name: string; first_seen: number } }
  | { DeviceAdded: { id: number[]; name: string; linked_at: number } }
  | { DeviceRemoved: { id: number[] } }
  | { DeviceRenamed: { id: number[]; name: string } }
  | { NameChanged: string };

interface Notice {
  v: number;
  from: number[];
  sent_at: number;
  body: NoticeBody;
}

const idBytes = (base64url: string) => fromBase64Url(base64url);

/**
 * This device's own id and name, allocated the first time anything asks.
 *
 * Allocated locally and never negotiated: it is a label for one machine, not a
 * key, and two devices colliding on 16 random bytes is not a scenario.
 */
export async function thisDevice(name?: string): Promise<DeviceRecord> {
  const [existingId, existingName] = await Promise.all([
    getMeta<string>(DEVICE_ID),
    getMeta<string>(DEVICE_NAME),
  ]);

  if (existingId) {
    const known = await getDevice(existingId);
    if (known && !name) return known;

    const updated: DeviceRecord = {
      id: existingId,
      name:
        cleanName(name ?? known?.name ?? existingName ?? DEFAULT_DEVICE_NAME) ||
        DEFAULT_DEVICE_NAME,
      linkedAt: known?.linkedAt ?? Date.now(),
    };
    await putDevice(updated);
    await setMeta(DEVICE_NAME, updated.name);
    return updated;
  }

  const device: DeviceRecord = {
    id: toBase64Url(randomBytes(16)),
    name: cleanName(name ?? '') || DEFAULT_DEVICE_NAME,
    linkedAt: Date.now(),
  };

  await setMeta(DEVICE_ID, device.id);
  await setMeta(DEVICE_NAME, device.name);
  await putDevice(device);
  return device;
}

/** Every device but this one. */
export async function otherDevices(): Promise<DeviceRecord[]> {
  const me = await getMeta<string>(DEVICE_ID);
  return (await listDevices()).filter((device) => device.id !== me);
}

/**
 * Tells this person's other devices something.
 *
 * One sealed copy each. Failures are swallowed per device: a laptop that is
 * off should not stop a phone starting a game.
 */
export async function announce(body: NoticeBody): Promise<void> {
  const others = await otherDevices();
  if (others.length === 0) return;

  const me = await thisDevice();
  const { identity } = await loadIdentity();
  const sentAt = Date.now();

  await Promise.all(
    others.map(async (device) => {
      try {
        const sealed = identity.sealDeviceNotice(
          idBytes(device.id),
          idBytes(me.id),
          randomBytes(24),
          BigInt(sentAt),
          JSON.stringify(body),
        );
        await postMailbox(
          toBase64Url(identity.deviceMailbox(idBytes(device.id))),
          toBase64Url(sealed),
        );
      } catch {
        // Nothing to do and nothing worth saying: the other device will find
        // out from its next poll, or from the game itself.
      }
    }),
  );
}

/** Announces a game exactly as this device holds it. */
export async function announceGame(game: GameRecord): Promise<void> {
  await announce({ GameKnown: await gameToJson(game) });
}

export async function announceGameGone(gameId: string): Promise<void> {
  await announce({ GameGone: { game_id: [...idBytes(gameId)] } });
}

export async function announceContact(
  publicKey: string,
  name: string,
  firstSeen: number,
): Promise<void> {
  await announce({
    ContactKnown: { public_key: [...idBytes(publicKey)], name, first_seen: firstSeen },
  });
}

export async function announceName(name: string): Promise<void> {
  await announce({ NameChanged: name });
}

/**
 * Reads this device's mailbox and applies what it finds.
 *
 * Anything that does not open is skipped: only a device holding this identity's
 * seed can write here, so a blob that will not decrypt is not from one of them.
 */
export async function pollDevices(): Promise<number> {
  const me = await getMeta<string>(DEVICE_ID);
  if (!me) return 0;

  const { identity } = await loadIdentity();
  const mailboxId = toBase64Url(identity.deviceMailbox(idBytes(me)));

  const mailboxes = await pollMailboxes([mailboxId]);
  const messages = mailboxes[mailboxId] ?? [];
  let applied = 0;

  for (const message of messages) {
    let notice: Notice;
    try {
      notice = JSON.parse(
        identity.openDeviceNotice(idBytes(me), fromBase64Url(message.body)),
      ) as Notice;
    } catch {
      continue;
    }

    try {
      await apply(notice, me);
      applied += 1;
    } finally {
      // Dropped even if applying it threw: a notice that cannot be applied
      // will not apply any better on the next poll, and leaving it there
      // fills a mailbox that has a cap.
      await deleteMailboxMessage(mailboxId, message.messageId).catch(() => {});
    }
  }

  return applied;
}

async function apply(notice: Notice, myId: string): Promise<void> {
  const from = toBase64Url(new Uint8Array(notice.from));
  await touchDevice(from, notice.sent_at);

  const body = notice.body;

  if ('GameKnown' in body) return applyGame(body.GameKnown);

  if ('GameGone' in body) {
    return deleteGame(toBase64Url(new Uint8Array(body.GameGone.game_id)));
  }

  if ('ContactKnown' in body) {
    const publicKey = toBase64Url(new Uint8Array(body.ContactKnown.public_key));
    await rememberContact(publicKey, body.ContactKnown.name, body.ContactKnown.first_seen);
    // A name learned on another device is a decision, not a guess, so it wins
    // over whatever this one is showing.
    await renameContact(publicKey, body.ContactKnown.name);
    return;
  }

  if ('DeviceAdded' in body) {
    const added = body.DeviceAdded;
    const id = toBase64Url(new Uint8Array(added.id));
    if (id === myId) return;
    await putDevice({ id, name: added.name, linkedAt: added.linked_at });
    return;
  }

  if ('DeviceRemoved' in body) {
    const id = toBase64Url(new Uint8Array(body.DeviceRemoved.id));
    // Being told it was this device is the whole of removal: nothing can take
    // the identity back off a machine that holds it, so a removed device is
    // asked to stop, and the app says as much where it offers the button.
    if (id === myId) {
      removed.by = from;
      return setMeta(REMOVED_BY, from);
    }
    await deleteDevice(id);
    return;
  }

  if ('DeviceRenamed' in body) {
    const id = toBase64Url(new Uint8Array(body.DeviceRenamed.id));
    const known = await getDevice(id);
    if (known) await putDevice({ ...known, name: body.DeviceRenamed.name });
    if (id === myId) await setMeta(DEVICE_NAME, body.DeviceRenamed.name);
    return;
  }

  if ('NameChanged' in body) {
    // Straight to storage rather than through `setDisplayName`, which would
    // announce it back and start the two devices telling each other forever.
    await setDisplayName(body.NameChanged);
  }
}

/**
 * Stores a game another device knows about, without discarding what this one
 * has learned.
 *
 * The log is the authority on a game in progress, and this device may have
 * replayed further than the sender had when it wrote. So entries are added,
 * never removed, and the turn summary is only taken from a notice that is
 * ahead of what is already here.
 */
async function applyGame(game: GameJson): Promise<void> {
  const gameId = toBase64Url(new Uint8Array(game.game_id));
  const { identity } = await loadIdentity();
  const mine = toBase64Url(identity.publicKey());
  const initiator = toBase64Url(new Uint8Array(game.initiator_pub_key));

  const incoming = gameFromJson(game, gameId, initiator === mine, Date.now());
  const existing = await getGame(gameId);

  if (!existing) {
    await putGame(incoming);
    return;
  }

  // Whichever device saw the game move most recently is the one to believe
  // about whose turn it is.
  if (incoming.lastActivity < existing.lastActivity) {
    await putGame({ ...incoming, ...existing });
    return;
  }

  await putGame({ ...existing, ...incoming });
}

async function touchDevice(id: string, at: number): Promise<void> {
  const known = await getDevice(id);
  if (!known || (known.lastSeenAt ?? 0) >= at) return;
  await putDevice({ ...known, lastSeenAt: at });
}

/**
 * Removes another device.
 *
 * Told first, then forgotten: the notice is what makes it stop, so sending it
 * after dropping the row would be sending it nowhere.
 */
export async function removeDevice(id: string): Promise<void> {
  await announce({ DeviceRemoved: { id: [...idBytes(id)] } });
  await deleteDevice(id);
}

export async function renameDevice(id: string, name: string): Promise<void> {
  const known = await getDevice(id);
  if (!known) return;

  const cleaned = cleanName(name) || DEFAULT_DEVICE_NAME;
  await putDevice({ ...known, name: cleaned });
  if (id === (await getMeta<string>(DEVICE_ID))) await setMeta(DEVICE_NAME, cleaned);

  await announce({ DeviceRenamed: { id: [...idBytes(id)], name: cleaned } });
}

/** Whether this device has been told to stop, and by which of the others. */
export async function removedBy(): Promise<string | undefined> {
  const stored = await getMeta<string>(REMOVED_BY);
  if (stored) removed.by = stored;
  return stored;
}

/** Names a device for the UI, falling back to something a person can read. */
export async function deviceName(id: string): Promise<string> {
  return (await getDevice(id))?.name ?? 'your other device';
}
