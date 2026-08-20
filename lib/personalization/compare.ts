/**
 * Diffing two profiles at (dimension, field) granularity.
 *
 * #42 shows a user what changed and why; #43 measures churn between windows.
 * Both need the same answer, so they get one implementation rather than two
 * that drift.
 *
 * ── Why (dimension, field) pairs and not a set of dimensions ─────
 *
 * Sprint 08 shipped a cross-track check that compared **deduplicated code
 * names** and reported perfect agreement while the two readers disagreed on 38%
 * of inputs — the names matched, the rows they belonged to did not. The same
 * shape is available here: "these two profiles both mention `pressure_ceiling`"
 * is true of a profile that went from `operative/low` to `suggestion/none`.
 *
 * So every change is located at a **pair**, and a dimension with three changed
 * fields yields three entries rather than one. A caller that wants the coarse
 * view can group; a caller given the coarse view cannot recover the fine one.
 *
 * ── Which fields, and why `evidence` is one of them ──────────────
 *
 * `status`, `level`, `confidence`, `sampleEventCount`, `reason` and `evidence`.
 * Evidence is compared as a canonical string rather than skipped, because a
 * reading whose *level and confidence are unchanged* but whose evidence moved
 * is a reading now standing on different facts. For #43 that is the difference
 * between a stable preference and one that is being re-derived from scratch
 * each window and landing in the same place by luck.
 *
 * ── Ordering ─────────────────────────────────────────────────────
 *
 * Dimension order follows `PREFERENCE_DIMENSIONS`, the contract's own declared
 * order, and field order follows `COMPARED_FIELDS` below. Neither is sorted at
 * runtime: `localeCompare` is forbidden in this repo (it changed output under
 * `tr_TR` in #121) and a fixed declared order needs no comparator at all.
 */
import {
  PREFERENCE_DIMENSIONS,
  type PersonalizationProfile,
  type PreferenceDimension,
  type PreferenceEvidence,
  type PreferenceReading,
} from '../../src/contracts/v1/personalizationContracts';

/** The fields compared, in report order. A field absent here is not compared. */
export const COMPARED_FIELDS = Object.freeze([
  'status',
  'level',
  'confidence',
  'sampleEventCount',
  'reason',
  'evidence',
] as const);

export type ComparedField = (typeof COMPARED_FIELDS)[number];

export interface PreferenceFieldChange {
  readonly dimension: PreferenceDimension;
  readonly field: ComparedField;
  /** Rendered, so a caller can display a change without re-narrowing the union. */
  readonly before: string;
  readonly after: string;
}

export interface PersonalizationProfileDiff {
  /**
   * Both consent states, because a diff across a consent flip is the single
   * most important one #42 displays and it must not read as "everything was
   * deleted". `changes` is empty when either side is disabled — a disabled
   * profile has no readings to compare, and inventing changes against `null`
   * would report a flip as four preference reversals.
   */
  readonly beforeConsent: PersonalizationProfile['consent'];
  readonly afterConsent: PersonalizationProfile['consent'];
  readonly consentChanged: boolean;
  readonly changes: readonly PreferenceFieldChange[];
}

function renderEvidence(evidence: readonly PreferenceEvidence[]): string {
  // Positional, and already in the deriver's declared rung/outcome order.
  return evidence.map((entry) => `${entry.rungIndex}:${entry.outcome}:${entry.count}`).join(',');
}

function renderField(reading: PreferenceReading, field: ComparedField): string {
  switch (field) {
    case 'status':
      return reading.status;
    case 'level':
      return reading.level === null ? '(none)' : reading.level;
    case 'confidence':
      // A number rendered by the same path on both sides, so an equal number
      // never reads as a change and an unequal one always does.
      return reading.confidence === null ? '(none)' : String(reading.confidence);
    case 'sampleEventCount':
      return String(reading.sampleEventCount);
    case 'reason':
      return reading.reason === null ? '(none)' : reading.reason;
    case 'evidence':
      return renderEvidence(reading.evidence);
  }
}

/**
 * Reports every (dimension, field) at which two profiles disagree.
 *
 * Reports rather than throws, and returns an empty change list rather than
 * refusing, when either side is disabled — see the note on `changes`.
 */
export function comparePersonalizationProfiles(
  before: PersonalizationProfile,
  after: PersonalizationProfile,
): PersonalizationProfileDiff {
  const beforeConsent = before.consent;
  const afterConsent = after.consent;
  const shell = {
    beforeConsent,
    afterConsent,
    consentChanged: beforeConsent !== afterConsent,
  };

  if (before.readings === null || after.readings === null) {
    return { ...shell, changes: [] };
  }

  const changes: PreferenceFieldChange[] = [];
  for (const dimension of PREFERENCE_DIMENSIONS) {
    const left = before.readings[dimension];
    const right = after.readings[dimension];
    for (const field of COMPARED_FIELDS) {
      const renderedBefore = renderField(left, field);
      const renderedAfter = renderField(right, field);
      if (renderedBefore !== renderedAfter) {
        changes.push({ dimension, field, before: renderedBefore, after: renderedAfter });
      }
    }
  }
  return { ...shell, changes };
}

/** True when nothing a consumer reads has moved. Consent counts as movement. */
export function profilesAgree(before: PersonalizationProfile, after: PersonalizationProfile): boolean {
  const diff = comparePersonalizationProfiles(before, after);
  return !diff.consentChanged && diff.changes.length === 0;
}
