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
    language: input.language,
    reasons: [...input.reasons],
    localSplit: input.localSplit,
    remoteSplit: input.verdict.correctedSplit,
    reviewed: false,
  };
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
  return Number((records.length / totalCaptures).toFixed(3));
}
