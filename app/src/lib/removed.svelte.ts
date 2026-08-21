/**
 * Whether this device has been signed out, as a thing the shell can watch.
 *
 * It is discovered mid-poll, from a mailbox, long after the layout last asked.
 * A stored flag alone would mean the device carried on as normal until the next
 * navigation — writing moves nobody will accept — so the poll sets this too and
 * the shell reacts at once.
 */
export const removed = $state<{ by: string | undefined }>({ by: undefined });
