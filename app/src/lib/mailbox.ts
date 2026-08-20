/**
 * Inviting someone you have played before, without sending them anything.
 *
 * The first game between two people needs a link — there is no other way to
 * reach a stranger, and that is the point of the link. Every game after it can
 * go through a mailbox the two of them can compute the address of and nobody
 * else can find. See ARCHITECTURE, "Inviting a contact".
 *
 * The invite itself is unchanged: it is created and claimed exactly as a link
 * invite is. What travels here is the two halves of the link, sealed, which is
 * all a link ever was.
 */
import { fromBase64Url, toBase64Url } from '@tabla/shared';

import { deleteInboxItem, getGame, listContacts, listInbox, putInboxItem } from './db/store.ts';
import type { ContactRecord, InboxRecord } from './db/schema.ts';
import { createGame, joinGame, type JoinResult } from './games.ts';
import { loadIdentity, randomBytes } from './identity.ts';
import { updateGame } from './db/store.ts';
import { deleteMailboxMessage, pollMailboxes, postMailbox, registerMailboxPush } from './relay.ts';
import type { PushSubscriptionJson } from '@tabla/shared';

/** The most mailboxes one poll may name, matching the relay's limit. */
const POLL_LIMIT = 64;

/**
 * Starts a game against a contact and delivers the invitation.
 *
 * If the delivery fails the game still exists and still has a shareable link —
 * the relay being unreachable is a reason to send it by hand, not to lose the
 * game that was just made.
 */
export async function inviteContact(
  origin: string,
  contact: ContactRecord,
  pluginId: string,
): Promise<{ gameId: string; delivered: boolean }> {
  const { game, link } = await createGame(origin, pluginId, undefined, contact);

  try {
    const { identity } = await loadIdentity();
    const peer = fromBase64Url(contact.publicKey);

    const sealed = identity.sealMailboxInvite(
      peer,
      randomBytes(24),
      fromBase64Url(game.blobId),
      fromBase64Url(game.blobKey ?? ''),
      game.pluginId,
      game.pluginVersion,
      BigInt(Date.now()),
    );

    const mailboxId = toBase64Url(identity.mailboxTo(peer));
    const { messageId } = await postMailbox(mailboxId, toBase64Url(sealed));
    await updateGame(game.gameId, { mailbox: { id: mailboxId, messageId } });

    return { gameId: game.gameId, delivered: true };
  } catch {
    // The link is still good; the waiting page will offer it.
    void link;
    return { gameId: game.gameId, delivered: false };
  }
}

/**
 * Collects invitations from every contact's mailbox.
 *
 * Anything that does not open is skipped rather than reported: the only things
 * that can appear in one of these is a message from the one person who can
 * write to it, so a failure to open means a corrupt or hostile blob, and the
 * response to it is to ignore it.
 */
export async function pollInbox(): Promise<InboxRecord[]> {
  const contacts = await listContacts();
  if (contacts.length === 0) return [];

  const { identity } = await loadIdentity();

  const addressed = contacts
    .map((contact) => {
      try {
        const peer = fromBase64Url(contact.publicKey);
        return { contact, mailboxId: toBase64Url(identity.mailboxFrom(peer)) };
      } catch {
        // A contact row we cannot parse a key from is not worth failing over.
        return null;
      }
    })
    .filter((entry): entry is { contact: ContactRecord; mailboxId: string } => entry !== null)
    .slice(0, POLL_LIMIT);

  if (addressed.length === 0) return [];

  const mailboxes = await pollMailboxes(addressed.map((entry) => entry.mailboxId));
  const found: InboxRecord[] = [];

  for (const { contact, mailboxId } of addressed) {
    for (const message of mailboxes[mailboxId] ?? []) {
      try {
        const opened = identity.openMailboxInvite(
          fromBase64Url(contact.publicKey),
          fromBase64Url(message.body),
        );

        const item: InboxRecord = {
          messageId: message.messageId,
          mailboxId,
          fromPubKey: contact.publicKey,
          blobId: toBase64Url(opened.blobId),
          blobKey: toBase64Url(opened.blobKey),
          pluginId: opened.pluginId,
          pluginVersion: opened.pluginVersion,
          createdAt: message.createdAt,
          receivedAt: Date.now(),
        };

        // Stored first, then dropped from the relay: a device that dies in
        // between is handed it again rather than losing it.
        await putInboxItem(item);
        await deleteMailboxMessage(mailboxId, message.messageId).catch(() => {});
        found.push(item);
      } catch {
        continue;
      }
    }
  }

  return found;
}

export async function inbox(): Promise<InboxRecord[]> {
  return listInbox();
}

/**
 * Takes up an invitation, which is what spends it.
 *
 * The claim is checked against the contact whose mailbox it came from: a
 * mailbox only they can write to is already strong evidence, and confirming the
 * key in the invite closes the gap between "only they could have left this" and
 * "this is a game with them".
 */
export async function acceptInvite(messageId: string): Promise<JoinResult> {
  const item = (await listInbox()).find((entry) => entry.messageId === messageId);
  if (!item) return { ok: false, reason: 'missing' };

  const result = await joinGame(`#${item.blobId}.${item.blobKey}`, item.fromPubKey);
  if (result.ok) await deleteInboxItem(messageId);

  return result;
}

/** Forgets an invitation without spending it. */
export async function declineInvite(messageId: string): Promise<void> {
  await deleteInboxItem(messageId);
}

/**
 * Retracts an invitation left for a contact.
 *
 * Best effort, and separate from cancelling the invite itself: taking the blob
 * off the relay is what makes the link dead, and this only saves the recipient
 * from being offered a game that no longer exists.
 */
export async function retractInvitation(gameId: string): Promise<void> {
  const game = await getGame(gameId);
  if (!game?.mailbox) return;

  await deleteMailboxMessage(game.mailbox.id, game.mailbox.messageId).catch(() => {});
}

/**
 * Asks to be told when an invitation arrives, for every contact.
 *
 * One registration per mailbox, because that is where a message lands. The
 * subscription is the same one the game rooms hold; the relay already sees it
 * against each room this device plays in.
 */
export async function registerInboxPush(subscription: PushSubscriptionJson): Promise<void> {
  const contacts = await listContacts();
  const { identity } = await loadIdentity();

  await Promise.all(
    contacts.map(async (contact) => {
      try {
        const mailboxId = toBase64Url(identity.mailboxFrom(fromBase64Url(contact.publicKey)));
        await registerMailboxPush(mailboxId, subscription);
      } catch {
        // One unreachable mailbox must not cost the others their notifications.
      }
    }),
  );
}
