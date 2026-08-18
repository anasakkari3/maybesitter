/**
 * Feature-vector builders for the Priority scorer tests (#18).
 *
 * #17 owns `lib/priority/priorityFeatures.ts` and it is built in parallel, so
 * nothing here imports it: the scorer takes `PriorityFeatures` as a parameter
 * and these tests construct vectors directly from the committed contract. That
 * is also the right coupling for the unit under test — the scorer's job is
 * arithmetic over a feature vector, not extraction.
 */
import type {
  ImportanceFeature,
  LatenessFeature,
  PriorityFeature,
  PriorityFeatures,
  UrgencyFeature,
  UserPressureFeature,
} from '../../src/contracts/v1/priorityContracts.ts';
import { PRIORITY_SCHEMA_VERSION } from '../../src/contracts/v1/priorityContracts.ts';

export const COMPUTED_AT = '2026-08-18T12:00:00.000Z';
export const OBSERVED_AT = '2026-08-18T11:00:00.000Z';

export function knownFeature<T>(value: T, source: string): PriorityFeature<T> {
  return {
    known: true,
    value: { value, evidence: [{ source, observedAt: OBSERVED_AT }] },
    provenance: { source: 'domain_state', derivedFrom: OBSERVED_AT, computedAt: COMPUTED_AT },
  };
}

export function unknownFeature(): PriorityFeature<never> {
  return {
    known: false,
    reason: 'NO_DATA',
    provenance: { source: 'absent', derivedFrom: null, computedAt: COMPUTED_AT },
  };
}

export interface FeatureOverrides {
  readonly commitmentId?: string;
  readonly urgency?: UrgencyFeature;
  readonly importance?: ImportanceFeature;
  readonly lateness?: LatenessFeature;
  readonly userPressure?: UserPressureFeature;
}

/**
 * Every feature defaults to unknown, so each test states only the features it
 * is actually about and an omission reads as "not measured" rather than zero.
 */
export function makeFeatures(overrides: FeatureOverrides = {}): PriorityFeatures {
  return {
    version: PRIORITY_SCHEMA_VERSION,
    commitmentId: overrides.commitmentId ?? 'cmt_1',
    computedAt: COMPUTED_AT,
    urgency:
      overrides.urgency === undefined
        ? unknownFeature()
        : knownFeature(overrides.urgency, 'commitment.timeSpec.dueAt'),
    importance:
      overrides.importance === undefined
        ? unknownFeature()
        : knownFeature(overrides.importance, 'commitment.priority.level'),
    lateness:
      overrides.lateness === undefined
        ? unknownFeature()
        : knownFeature(overrides.lateness, 'reminder:rem_1'),
    userPressure:
      overrides.userPressure === undefined
        ? unknownFeature()
        : knownFeature(overrides.userPressure, 'reminder:rem_2'),
    dependency: unknownFeature(),
    effort: unknownFeature(),
  };
}

/** The feature values that together reach the 1350-point raw band maximum. */
export const MAXIMAL_FEATURES: FeatureOverrides = {
  urgency: { hoursOverdue: 100, dueSoonCloseness: 0 },
  importance: { level: 'high', userSet: false },
  lateness: { snoozedCount: 3, postponed: true, deferred: true },
  userPressure: { ignoredCount: 2, ignoredRecently: true },
};
