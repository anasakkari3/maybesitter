/**
 * The one line the top card gets (UC-2.8 #169, rendered by UC-2.R3 #173).
 *
 * ── One card, one line, at most two reasons ──────────────────────
 *
 * Every card explaining itself is no explanation at all, and a card giving
 * three reasons is arguing rather than telling. The server already caps
 * `reasonCodes` at two and puts the deadline first; this renders them in that
 * order and nothing else.
 *
 * ── Built from codes, never from prose ───────────────────────────
 *
 * The server sends `overdue`, not "the time has passed". A sentence assembled
 * on the server could not be translated, and one assembled from a model could
 * not be predicted. Each code maps to one short phrase per language, so the
 * line is deterministic and a test can assert its exact words.
 */
import type { RankReasonCode } from '../../api/schemas/common';

const REASON_KEY: Record<RankReasonCode, string> = {
  overdue: 'todayWhyOverdue',
  due_within_2h: 'todayWhySoon',
  due_today: 'todayWhyToday',
  user_must: 'todayWhyMust',
  user_low: '',
  estimated_important: 'todayWhyEstimated',
  no_deadline: 'todayWhyNoDeadline',
};

/**
 * The line, or null when there is nothing worth saying.
 *
 * `user_low` has no phrase on purpose: "why first: you marked it nice" is not
 * a reason it is first, it is a reason it is not — and printing it on the top
 * card would be the product contradicting itself.
 */
export function whyFirstLine(
  reasonCodes: readonly string[],
  strings: Record<string, string>,
): string | null {
  const phrases = reasonCodes
    .map((code) => REASON_KEY[code as RankReasonCode])
    .filter((key) => key !== undefined && key !== '')
    .map((key) => strings[key])
    .filter((phrase): phrase is string => typeof phrase === 'string' && phrase !== '');

  if (phrases.length === 0) return null;
  if (phrases.length === 1) return phrases[0]!;

  // Only the first two, and joined by the template so the separator can differ
  // per language without this function knowing.
  const template = strings.todayWhyJoin ?? '{first} · {second}';
  return template.replace('{first}', phrases[0]!).replace('{second}', phrases[1]!);
}
