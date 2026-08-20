/**
 * Rebuild: event log -> rung aggregates -> profile, in one deterministic
 * step. This is the function the reproducibility criterion is stated over —
 * same non-revoked events, byte-identical profile — and the seam #42 uses to
 * re-derive after a correction and #43 uses to build both comparison arms.
 *
 * It owns no aggregation logic: each rung is Sprint 03's `aggregateFeedback`
 * verbatim, so windowing, revocation and the input digest cannot diverge from
 * the aggregates the rest of the product reports. The consent gate is applied
 * *before* aggregation — a disabled rebuild does no work on data it has no
 * consent to read, and therefore cannot fail on it either.
 */

import { aggregateFeedback } from '../feedback/feedbackAggregation';
import type { FeedbackBaseline, FeedbackEvent } from '../../src/contracts/v1/feedbackContracts';
import {
  PERSONALIZATION_WINDOW_LADDER_DAYS,
  type FeedbackAggregates,
  type Instant,
  type PersonalizationConsent,
  type PersonalizationProfile,
} from '../../src/contracts/v1/personalizationContracts';
import { derivePersonalizationProfile } from './derive';

export interface PersonalizationRebuildInput {
  readonly scopeId: string;
  /** The derivation instant. This module never reads a clock. */
  readonly now: Instant;
  readonly consent: PersonalizationConsent;
  readonly events: readonly FeedbackEvent[];
  readonly baseline: FeedbackBaseline | null;
}

/**
 * One aggregate per ladder rung, all at the same instant. The baseline rides
 * along because it is part of the digested input — two logs differing only in
 * their migration baseline must not share a basis digest — even though the
 * deriver reads windowed counts, which a baseline can never reach.
 */
export function rungAggregatesFor(input: {
  readonly scopeId: string;
  readonly now: Instant;
  readonly events: readonly FeedbackEvent[];
  readonly baseline: FeedbackBaseline | null;
}): readonly FeedbackAggregates[] {
  return PERSONALIZATION_WINDOW_LADDER_DAYS.map((windowDays) =>
    aggregateFeedback({
      events: input.events,
      baseline: input.baseline,
      scopeId: input.scopeId,
      now: input.now,
      windowDays,
    }),
  );
}

export function rebuildPersonalizationProfile(
  input: PersonalizationRebuildInput,
): PersonalizationProfile {
  const consentState =
    input.consent === null || input.consent === undefined ? undefined : input.consent.state;
  return derivePersonalizationProfile({
    scopeId: input.scopeId,
    now: input.now,
    consent: input.consent,
    // The deriver's consent gate precedes rung validation, so a disabled
    // rebuild may pass an empty list and skip aggregation entirely.
    rungAggregates:
      consentState === 'enabled'
        ? rungAggregatesFor({
            scopeId: input.scopeId,
            now: input.now,
            events: input.events,
            baseline: input.baseline,
          })
        : [],
  });
}
