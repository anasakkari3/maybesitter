import {
  docIdForKey,
  getStorage,
  NEXT_STEP_DECISIONS,
  requireUserId,
  userCol,
} from '../../storage';
import type { NextStepDecision } from '../../../src/contracts/v1/nextStepContracts';

/**
 * What the user answered to a next step, and for how long it counts
 * (UC-2.9, #170).
 *
 * ── This is the user's own history, not analytics ────────────────
 *
 * It is written whatever the analytics consent says, because it is not
 * telemetry: it is the record of a decision the person made, it is what
 * `defer` and `dismiss` actually mean, and it is what the feedback history
 * screen shows them about themselves. Making it conditional on analytics would
 * mean a user who declined telemetry silently loses the ability to dismiss
 * anything.
 *
 * ── Deferring changes the suggestion, never the commitment ───────
 *
 * A deferred or dismissed item keeps its due time, its priority and its place
 * on Today, Upcoming and Details. The only thing that changes is that the next
 * step stops offering it for a while. "Not this one" is an answer about the
 * suggestion, and reading it as an edit to the commitment would let a tap on a
 * card quietly rewrite something the user did not touch.
 */
export interface NextStepDecisionRecord {
  proposalId: string;
  commitmentId: string | null;
  decision: NextStepDecision;
  arm: string;
  evidenceCodes: string[];
  /** When the item becomes eligible again. Null for decisions that do not hide it. */
  deferUntil: string | null;
  at: string;
}

/** A dismissal hides the item for a day. */
export const DISMISS_MS = 24 * 60 * 60 * 1000;
/** The default defer, when the client did not name a time. */
export const DEFER_DEFAULT_MS = 24 * 60 * 60 * 1000;
/** How far back eligibility looks. Older decisions cannot hide anything. */
export const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The document id.
 *
 * Derived from the proposal and the decision rather than random, so the same
 * decision recorded twice — a retry above the idempotency layer, say — is one
 * row instead of two, and the history cannot show a user deciding the same
 * thing twice when they tapped once.
 */
function decisionDocId(record: NextStepDecisionRecord): string {
  return docIdForKey(`${record.proposalId}:${record.decision}:${record.at}`);
}

export async function appendNextStepDecision(
  uid: string,
  record: NextStepDecisionRecord,
): Promise<void> {
  requireUserId(uid);
  await getStorage().set(
    `${userCol(uid, NEXT_STEP_DECISIONS)}/${decisionDocId(record)}`,
    record as unknown as Record<string, unknown>,
  );
}

/** Everything decided inside the history window, newest first. */
export async function listRecentNextStepDecisions(
  uid: string,
  now: Date,
): Promise<NextStepDecisionRecord[]> {
  requireUserId(uid);
  const since = now.getTime() - HISTORY_WINDOW_MS;
  const rows = await getStorage().list<NextStepDecisionRecord>(userCol(uid, NEXT_STEP_DECISIONS));
  return rows
    .map((row) => row.data)
    .filter((record) => {
      const at = Date.parse(record.at);
      return Number.isFinite(at) && at >= since;
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

/**
 * The commitments the next step should not offer right now.
 *
 * A later decision wins: dismissing something and then deferring it to an hour
 * from now means it comes back in an hour, not tomorrow. Records are walked
 * newest first and the first one that speaks about a commitment decides it.
 */
export function hiddenCommitmentIds(
  decisions: readonly NextStepDecisionRecord[],
  now: Date,
): Set<string> {
  const hidden = new Set<string>();
  const settled = new Set<string>();

  for (const record of [...decisions].sort((left, right) => Date.parse(right.at) - Date.parse(left.at))) {
    const id = record.commitmentId;
    if (!id || settled.has(id)) continue;

    if (record.decision === 'dismiss') {
      settled.add(id);
      if (now.getTime() < Date.parse(record.at) + DISMISS_MS) hidden.add(id);
      continue;
    }
    if (record.decision === 'defer') {
      settled.add(id);
      const until = record.deferUntil
        ? Date.parse(record.deferUntil)
        : Date.parse(record.at) + DEFER_DEFAULT_MS;
      if (Number.isFinite(until) && now.getTime() < until) hidden.add(id);
      continue;
    }
    // accept, edit and done say nothing about eligibility: an accepted item is
    // the one the user is doing, and a completed one leaves the candidate set
    // by being completed.
    settled.add(id);
  }

  return hidden;
}

/** The window a `deferUntil` may name, so a client cannot hide an item forever. */
export const DEFER_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The instant a defer runs until.
 *
 * A client-supplied time is honoured when it is in the future and inside the
 * cap; anything else falls back to the default. The cap exists because
 * "deferred" is invisible to the user everywhere except by absence — there is
 * no screen that lists what the next step is currently ignoring — so a bad
 * value would hide a commitment from suggestions with nothing to show for it.
 */
export function resolveDeferUntil(requested: unknown, now: Date): string {
  const fallback = new Date(now.getTime() + DEFER_DEFAULT_MS).toISOString();
  if (typeof requested !== 'string') return fallback;
  const parsed = Date.parse(requested);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= now.getTime()) return fallback;
  if (parsed > now.getTime() + DEFER_MAX_MS) return fallback;
  return new Date(parsed).toISOString();
}
