import type { ArbitrationVerdict } from './arbiter';
import type { EscalationReason } from './escalationGate';

export interface DisagreementRecord {
  id: string;
  recordedAt: string;
  language: string;
  reasons: EscalationReason[];
  localSplit: number;
  remoteSplit: number | null;
  reviewed: boolean;
}

/**
 * A disagreement between the two models is a labelled example the remote
 * model produced for free -- and the only thing currently moving the
 * fine-tune counter off zero.
 *
 * The record deliberately carries no raw text and no arbiter note: the note
 * is free text and routinely quotes the sentence back. The commitment id is
 * enough to retrieve the text from the device later, with the participant's
 * consent. Every field is written out by hand for that reason -- spreading
 * the verdict in would carry the note with it.
 */
export function recordDisagreement(input: {
  id: string;
  language: string;
  reasons: EscalationReason[];
  localSplit: number;
  verdict: ArbitrationVerdict;
  now: Date;
}): DisagreementRecord | null {
  // Keyed on `outcome`, not `agrees`. Both say "the local proposal stands"
  // for a call that timed out or was refused, but only a real correction is
  // a labelled example; counting an outage would inflate the rate the
  // thresholds are tuned against.
  if (input.verdict.outcome !== 'disagreed') return null;

  return {
    id: input.id,
    recordedAt: input.now.toISOString(),
    // Both of these are narrowed rather than copied. `options.arbiter` is
    // caller-supplied, so parseArbitrationVerdict never runs on its result and
    // the types are erased by the time this executes -- a `correctedSplit`
    // carrying a sentence would otherwise land in a record whose whole purpose
    // is to hold no text.
    language: LANGUAGE_TAG.test(input.language) ? input.language : UNKNOWN_LANGUAGE,
    reasons: [...input.reasons],
    localSplit: input.localSplit,
    remoteSplit: asCount(input.verdict.correctedSplit),
    reviewed: false,
  };
}

/** BCP-47-ish: a language subtag, optionally with a region. Never a sentence. */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/** Recorded when the caller's language tag is not one. */
export const UNKNOWN_LANGUAGE = 'und';

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The measured uncertainty rate -- the number the threshold tuning needs. */
export function disagreementRate(
  records: readonly DisagreementRecord[],
  totalCaptures: number,
): number {
  if (totalCaptures === 0) return 0;
  if (records.length > totalCaptures) {
    // Silently returning a rate above 1 would corrupt any threshold tuned
    // against it, and the caller has miscounted its own window.
    throw new RangeError(
      `more disagreements (${records.length}) than captures (${totalCaptures})`,
    );
  }
  // Returned unrounded. Rounding to three places reported one disagreement in
  // three thousand as 0, which a tuner cannot tell apart from a pipeline that
  // is not running. Round at the display site instead.
  return records.length / totalCaptures;
}
