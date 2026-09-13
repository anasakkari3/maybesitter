/**
 * The order Today puts things in (UC-2.8, #169).
 *
 * ── It does not do the scoring ───────────────────────────────────
 *
 * `scorePriority` with `DEFAULT_PRIORITY_POLICY` produces the base score,
 * exactly as the web agenda gets it. That policy is not touched and neither is
 * the arithmetic — `tests/priority/priorityDelegationEquivalence.test.ts` pins
 * the two together and must keep passing unchanged. What this module adds is a
 * single importance adjustment on top, and the tie-breaks.
 *
 * Two ranking implementations is how a product ends up explaining an order it
 * does not actually produce.
 *
 * ── What the user said always beats what was guessed ─────────────
 *
 * `Priority.source` already carries the distinction: `user_explicit` is
 * something the person stated, `inferred` is the extractor's reading of their
 * words, `default` is nobody's opinion. The adjustment is weighted so that a
 * guess is worth at most half of a statement, and — because the adjustment is
 * capped below the gap between bands — **no guess can lift an item past an
 * overdue or due-soon one**. That is the property the whole feature rests on:
 * being wrong about importance should cost a place in a list, never the thing
 * that was actually due.
 *
 * ── No clock, no locale ──────────────────────────────────────────
 *
 * `now` is a parameter and ties break on `compareByCodePoint`, never
 * `localeCompare`, so the same input produces the same order on every device
 * in every timezone. A list that reorders itself between two phones is a list
 * nobody can be told the reason for.
 */
import {
  DEFAULT_DUE_SOON_WINDOW_MS,
  extractPriorityFeatures,
} from './priorityFeatures';
import { scorePriority } from './priorityScorer';
import { DEFAULT_PRIORITY_POLICY } from './priorityPolicy';
import { compareByCodePoint } from '../planning/shared/compare';
import { resolvedCommitmentTime } from '../services/mobile/time';
import type { PriorityReason } from '../../src/contracts/v1/priorityContracts';
import type { Commitment, Reminder } from '../../src/domain/stateMachine';

/**
 * Why an item is where it is, in the order the phone shows them.
 *
 * Deadline codes come first and at most two are ever returned: the top card
 * renders one short line, and three reasons is not an explanation.
 */
export const RANK_REASON_CODES = [
  'overdue',
  'due_within_2h',
  'due_today',
  'user_must',
  'user_low',
  'estimated_important',
  'no_deadline',
] as const;

export type RankReasonCode = (typeof RANK_REASON_CODES)[number];

export interface RankedItem {
  readonly commitmentId: string;
  /** 0-based, ascending: 0 is the item to do first. */
  readonly rank: number;
  readonly reasonCodes: readonly RankReasonCode[];
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * How far an importance signal may move an item.
 *
 * A user's explicit `high` is worth 150 and their `low` −100. A guess is worth
 * half: 75 and −50. The numbers matter less than the two relationships they
 * encode — a statement outweighs a guess, and both together are smaller than
 * the distance between the overdue band and the rest, which is what makes the
 * "a guess never outranks a deadline" property structural rather than lucky.
 */
const IMPORTANCE_ADJUSTMENT = {
  user_explicit: { high: 150, normal: 0, low: -100 },
  inferred: { high: 75, normal: 0, low: -50 },
  default: { high: 0, normal: 0, low: 0 },
} as const;

/** The band an item sits in, chosen the way the agenda chooses it. */
function bandFor(commitment: Commitment, nowMs: number, dueSoonWindowMs: number): PriorityReason {
  const resolved = resolvedCommitmentTime(commitment);
  const dueMs = resolved ? Date.parse(resolved) : Number.NaN;
  if (!Number.isNaN(dueMs) && dueMs < nowMs) return 'overdue';
  if (commitment.status === 'pending_confirmation') return 'pending';
  if (!Number.isNaN(dueMs) && dueMs - nowMs <= dueSoonWindowMs) return 'due_soon';
  return 'active';
}

function reasonCodesFor(
  commitment: Commitment,
  band: PriorityReason,
  nowMs: number,
): RankReasonCode[] {
  const codes: RankReasonCode[] = [];
  const resolved = resolvedCommitmentTime(commitment);
  const dueMs = resolved ? Date.parse(resolved) : Number.NaN;

  // Deadline first, and only the sharpest one: "overdue" and "due today" on the
  // same card would be two ways of saying one thing.
  if (Number.isNaN(dueMs)) codes.push('no_deadline');
  else if (dueMs < nowMs) codes.push('overdue');
  else if (dueMs - nowMs <= TWO_HOURS_MS) codes.push('due_within_2h');
  else if (dueMs - nowMs <= DEFAULT_DUE_SOON_WINDOW_MS) codes.push('due_today');

  const { level, source } = commitment.priority;
  if (source === 'user_explicit' && level === 'high') codes.push('user_must');
  else if (source === 'user_explicit' && level === 'low') codes.push('user_low');
  else if (source === 'inferred' && level === 'high') codes.push('estimated_important');

  return codes.slice(0, 2);
}

interface Scored {
  commitment: Commitment;
  total: number;
  codes: RankReasonCode[];
  dueMs: number;
}

export interface RankForMobileOptions {
  readonly dueSoonWindowMs?: number;
}

/**
 * Every commitment, in the order to tackle them.
 *
 * Undated items are included — `isVisibleInLists` used to drop them, so "Buy
 * milk" never reached a phone at all — and sort after dated items in the same
 * band, which is what `no_deadline` says on the card.
 */
export function rankForMobile(
  commitments: readonly Commitment[],
  reminders: readonly Reminder[],
  now: string,
  options: RankForMobileOptions = {},
): RankedItem[] {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new Error('rankForMobile: now must be an ISO timestamp');
  const dueSoonWindowMs = options.dueSoonWindowMs ?? DEFAULT_DUE_SOON_WINDOW_MS;

  const scored: Scored[] = commitments.map((commitment) => {
    const related = reminders.filter((reminder) => reminder.commitmentId === commitment.id);
    const band = bandFor(commitment, nowMs, dueSoonWindowMs);
    const base = scorePriority({
      features: extractPriorityFeatures({ commitment, reminders: related, now, dueSoonWindowMs }),
      reason: band,
      policy: DEFAULT_PRIORITY_POLICY,
    });
    const adjustment = IMPORTANCE_ADJUSTMENT[commitment.priority.source][commitment.priority.level];
    const resolved = resolvedCommitmentTime(commitment);
    return {
      commitment,
      total: base.total + adjustment,
      codes: reasonCodesFor(commitment, band, nowMs),
      dueMs: resolved ? Date.parse(resolved) : Number.POSITIVE_INFINITY,
    };
  });

  scored.sort((a, b) => (
    // Higher score first; then the earlier deadline, with undated last; then
    // the id, so the order is total and reproducible.
    b.total - a.total
    || a.dueMs - b.dueMs
    || compareByCodePoint(a.commitment.id, b.commitment.id)
  ));

  return scored.map((entry, index) => Object.freeze({
    commitmentId: entry.commitment.id,
    rank: index,
    reasonCodes: Object.freeze(entry.codes),
  }));
}
