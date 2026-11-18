/**
 * «ما اتصرّفت فيها» — the things nothing was done about (owner decision
 * 2026-11-12, spec Part 1, design item 2, lane E2).
 *
 * ── What is in the place ─────────────────────────────────────────
 *
 * Two kinds of item, still open (`active`, or `deferred` after a «لسّا»):
 *
 *   - `event_ended` — an appointment or meeting that is over (`hasEventEnded`,
 *     lane E1). It already left every active surface; the person never said
 *     what came of it.
 *   - `deadline_passed` — a `due_by` whose time passed. The time is the one the
 *     person last chose: `postponedUntil` when they put it off, otherwise
 *     `dueAt`; a deadline named by a day closes at the midnight ending that
 *     day, in the zone it was named in.
 *
 * A task keeps #383 and is never here: a clock-time task, an `unsure` item and
 * an undated one roll into Today until the person acts on them. A football
 * match is never here either (`fixtureCommitmentIds`): the maintenance pass
 * closes an ended one for every account.
 *
 * ── What the place writes, and what it never writes ──────────────
 *
 * Done, a new date and dropped on purpose are the existing status commands,
 * through `POST /api/mobile/commitments/{id}/actions` — each takes the item out
 * of the place because it is no longer open, or no longer past.
 *
 * «لا تسألني عنها» changes no status. It writes one `unhandledMarks` document
 * holding the instant the item was dismissed *for* (`since`): an item later
 * given a new time that passes too has a different `since`, so it comes back
 * rather than being silenced for ever. The commitment stays exactly as it was,
 * in history and in every list that would show it.
 *
 * The same document counts the times capture asked about the item (lane E3
 * asks no more than `MAX_UNHANDLED_ASKS`).
 *
 * Every write reads `users/{uid}` in its own transaction and refuses an account
 * being deleted (#772). Nothing here logs, and nothing calls a model.
 */
import type { Commitment } from '../../../src/domain/stateMachine';
import { normalizeStoredCommitment } from '../../../src/domain/stateMachine';
import { assertLiveAccount } from '../../account/accountLiveness';
import { fixtureCommitmentIds } from '../../football/projectFixtures';
import { getStorage, UNHANDLED_MARKS, userCol, userDoc, userSubDoc, docIdForKey, requireDocId, requireUserId } from '../../storage';
import { eventEndsAt, hasEventEnded } from '../commitments/eventEnded';
import { getParticipantStateSnapshot, commitmentDocPath } from './participantState';
import { addLocalDays } from './time';

export type UnhandledReason = 'event_ended' | 'deadline_passed';

/** Lane E3: no item is asked about more than twice (spec, "No pressure"). */
export const MAX_UNHANDLED_ASKS = 2;

export interface UnhandledAnchor {
  reason: UnhandledReason;
  /** When it ended, or when the deadline passed. */
  since: string;
}

export interface UnhandledItem extends UnhandledAnchor {
  commitment: Commitment;
  /** How many times capture asked about it (lane E3). */
  askCount: number;
}

interface UnhandledMark {
  commitmentId: string;
  askCount: number;
  lastAskedAt: string | null;
  /** The `since` it was dismissed for, or null while it is not dismissed. */
  dismissedFor: string | null;
  dismissedAt: string | null;
}

/** Still open: the person has not said what happened. */
const OPEN_STATUSES = new Set<Commitment['status']>(['active', 'deferred']);

/** The item is not (or no longer) in the place: settled, moved ahead, or a task. */
export class NotUnhandledError extends Error {
  constructor() {
    super('not_unhandled');
    this.name = 'NotUnhandledError';
  }
}

function deadlinePassesAt(commitment: Commitment): string | null {
  const { timeSpec } = commitment;
  if (timeSpec.kind !== 'due_by') return null;
  if (commitment.postponedUntil) return commitment.postponedUntil;
  if (!timeSpec.dueAt) return null;
  return timeSpec.allDay ? addLocalDays(timeSpec.dueAt, 1, timeSpec.timezone) : timeSpec.dueAt;
}

/** Why `commitment` is in the place at `now`, or null when it is not. Pure. */
export function unhandledAnchor(commitment: Commitment, now: Date): UnhandledAnchor | null {
  if (!OPEN_STATUSES.has(commitment.status)) return null;
  if (hasEventEnded(commitment, now)) {
    const end = eventEndsAt(commitment);
    return end ? { reason: 'event_ended', since: end } : null;
  }
  const passes = deadlinePassesAt(commitment);
  if (passes === null) return null;
  const passesMs = Date.parse(passes);
  if (!Number.isFinite(passesMs) || passesMs > now.getTime()) return null;
  return { reason: 'deadline_passed', since: new Date(passesMs).toISOString() };
}

function markDocId(commitmentId: string): string {
  try {
    return requireDocId(commitmentId);
  } catch {
    return docIdForKey(commitmentId);
  }
}

function markPath(uid: string, commitmentId: string): string {
  return userSubDoc(uid, UNHANDLED_MARKS, markDocId(commitmentId));
}

function emptyMark(commitmentId: string): UnhandledMark {
  return { commitmentId, askCount: 0, lastAskedAt: null, dismissedFor: null, dismissedAt: null };
}

/** The place, most recent first. Reads only; changes nothing. */
export async function listUnhandled(uid: string, options: { now?: Date } = {}): Promise<{ items: UnhandledItem[] }> {
  requireUserId(uid);
  const now = options.now ?? new Date();
  const [state, rows, matches] = await Promise.all([
    getParticipantStateSnapshot(uid),
    getStorage().list<UnhandledMark>(userCol(uid, UNHANDLED_MARKS)),
    fixtureCommitmentIds(uid),
  ]);
  const marks = new Map(rows.map(({ data }) => [data.commitmentId, data]));
  const items: UnhandledItem[] = [];
  for (const commitment of Object.values(state.commitments)) {
    if (matches.has(commitment.id)) continue;
    const anchor = unhandledAnchor(commitment, now);
    if (!anchor) continue;
    const mark = marks.get(commitment.id);
    if (mark?.dismissedFor === anchor.since) continue;
    items.push({ ...anchor, commitment, askCount: mark?.askCount ?? 0 });
  }
  items.sort((a, b) => Date.parse(b.since) - Date.parse(a.since) || a.commitment.id.localeCompare(b.commitment.id));
  return { items };
}

/**
 * «لا تسألني عنها»: the item leaves the place without its status changing.
 * A second press finds it already dismissed for the same `since`, writes
 * nothing and answers `replayed: true`.
 */
export async function dismissUnhandled(
  uid: string,
  commitmentId: string,
  options: { now?: Date } = {},
): Promise<{ replayed: boolean }> {
  requireUserId(uid);
  const now = options.now ?? new Date();
  // A match is never listed, so it is never dismissed either (review, item 6).
  const matches = await fixtureCommitmentIds(uid);
  return getStorage().runTransaction(async (tx) => {
    assertLiveAccount(await tx.get(userDoc(uid)));
    const stored = await tx.get<Commitment>(commitmentDocPath(uid, commitmentId));
    if (!stored || stored.id !== commitmentId || stored.status === 'archived') throw new Error('Commitment not found');
    const anchor = matches.has(commitmentId) ? null : unhandledAnchor(normalizeStoredCommitment(stored), now);
    if (!anchor) throw new NotUnhandledError();
    const path = markPath(uid, commitmentId);
    const mark = (await tx.get<UnhandledMark>(path)) ?? emptyMark(commitmentId);
    if (mark.dismissedFor === anchor.since) return { replayed: true };
    tx.set<UnhandledMark>(path, { ...mark, dismissedFor: anchor.since, dismissedAt: now.toISOString() });
    return { replayed: false };
  });
}

/**
 * Lane E3 asked about these items once more. Ids the account does not hold
 * are ignored; nothing about the question or the answer is stored.
 */
export async function recordUnhandledAsked(
  uid: string,
  commitmentIds: readonly string[],
  options: { now?: Date } = {},
): Promise<void> {
  requireUserId(uid);
  const at = (options.now ?? new Date()).toISOString();
  const unique = Array.from(new Set(commitmentIds));
  await getStorage().runTransaction(async (tx) => {
    assertLiveAccount(await tx.get(userDoc(uid)));
    const commitments = await Promise.all(unique.map((id) => tx.get<Commitment>(commitmentDocPath(uid, id))));
    const marks = await Promise.all(unique.map((id) => tx.get<UnhandledMark>(markPath(uid, id))));
    unique.forEach((id, index) => {
      if (!commitments[index]) return;
      const mark = marks[index] ?? emptyMark(id);
      tx.set<UnhandledMark>(markPath(uid, id), { ...mark, askCount: mark.askCount + 1, lastAskedAt: at });
    });
  });
}
