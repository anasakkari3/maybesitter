/**
 * The one line shown when nothing was created (UC-2.6, #166).
 *
 * ── Why this is a lookup and not a sentence ──────────────────────
 *
 * A message that asked for nothing is very often somebody telling the product
 * how their day went, and the temptation is to answer *that*. #166 forbids it:
 * no advice, no emotional or medical reading, no echo of what they wrote. The
 * server sends a reason code — never a reading of the text — and this maps it
 * to one fixed neutral line that a person wrote and reviewed.
 *
 * `noCommitmentCopy.test.ts` already guards the words themselves. This is the
 * missing half: the code that puts them on a screen.
 *
 * An unrecognised reason, or none at all, falls back to the generic
 * "nothing to save here" line rather than to silence — the user pressed a
 * button and is owed an answer.
 */
export type NoCommitmentReason =
  | 'informational'
  | 'greeting_or_chat'
  | 'question'
  | 'past_event'
  | 'negated_request'
  | 'low_confidence';

const REASON_KEY: Record<NoCommitmentReason, string> = {
  informational: 'noCommitmentInformational',
  greeting_or_chat: 'noCommitmentGreetingOrChat',
  question: 'noCommitmentQuestion',
  past_event: 'noCommitmentPastEvent',
  negated_request: 'noCommitmentNegatedRequest',
  low_confidence: 'noCommitmentLowConfidence',
};

/** The keys this build can say. A test pins it against the schema's enum. */
export const NO_COMMITMENT_REASONS = Object.keys(REASON_KEY) as NoCommitmentReason[];

export function noCommitmentLine(
  reason: string | null | undefined,
  strings: Record<string, string>,
): string {
  const key = reason ? REASON_KEY[reason as NoCommitmentReason] : undefined;
  return (key ? strings[key] : undefined) ?? strings.noCommitmentInformational ?? '';
}
