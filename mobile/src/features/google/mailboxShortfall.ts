import type { ShareProposal } from '../../api/schemas/share';

/**
 * How much of a Gmail scan went unread, or null when all of it was read
 * (CL6a review I2).
 *
 * The server reads a scan in at most three model calls and stops when the
 * model will not answer (a quota, an outage). What it did not read it counts
 * in `share.metrics.messagesNotRead`, and those messages are never "nothing to
 * save": the Google page and the review screen say how many were read
 * instead. Only the mailbox scan sets these counts; a shared email or file
 * has none, so this is null for every other share.
 */
export interface MailboxShortfall {
  readonly read: number;
  readonly total: number;
}

export function mailboxShortfall(proposal: Pick<ShareProposal, 'share'> | null | undefined): MailboxShortfall | null {
  const metrics = proposal?.share?.metrics;
  if (!metrics) return null;
  const notRead = metrics.messagesNotRead ?? 0;
  if (notRead <= 0) return null;
  const read = Math.max(0, metrics.messagesRead ?? 0);
  const total = Math.max(read + notRead, metrics.messagesFound ?? 0);
  return { read, total };
}
