/**
 * The control centre's read model: everything the system holds about one person,
 * assembled once, in plain language.
 *
 * ── Why the presenter, not the UI, decides what "effective" means ─
 *
 * Three things can set a preference: the product default, a derived reading, and
 * a correction the user typed. The precedence between them is a *policy*, and a
 * policy spread across a React component is a policy nobody can test. It lives
 * here, in `effectiveFor`, as one function with one ordering:
 *
 *     user correction  >  operative reading  >  product default
 *
 * A `suggestion` reading is deliberately absent from that list. The contract
 * gives it its own variant precisely so it cannot reach hard behaviour, and a
 * presenter that quietly promoted it would undo the type's whole purpose. It is
 * shown to the user — it is a real thing the system believes — but it does not
 * move `effective`.
 *
 * ── Why corrections survive a disabled profile ───────────────────
 *
 * #42's criterion is that controls work independently of model availability. A
 * user who turns personalization off and *also* told us to be quieter has said
 * two different things, and honouring only the first would be reading "stop
 * inferring" as "forget what I told you". Corrections are stated facts, not
 * inferences, so they outlive the deriver.
 *
 * ── The four ways preferences can be unavailable ─────────────────
 *
 * `derived` | `disabled` | `deriver_unavailable` | `profile_invalid`, as a
 * discriminated union rather than an empty list with a flag. Each is a different
 * sentence to a user, and collapsing them is how "the learner is not plugged in"
 * comes to look like "we know nothing about you". `profile_invalid` fails closed:
 * the defect codes are reported and **no reading leaks out**, because a profile
 * the contract rejects is not a profile whose readings are safe to display.
 *
 * ── The adaptive classification (#107) ───────────────────────────
 *
 * `adaptiveService` classifies every user as avoidant / inconsistent /
 * disciplined from their own behaviour and sets how hard the product pushes
 * them. It is live today through `/api/agenda`, its thresholds rest on nothing,
 * and the person it is about cannot see it. It is shown here with its inputs,
 * its effect, and a note that it is a label — which is the minimum a system owes
 * someone it has categorised.
 *
 * It is shown **regardless of personalization consent**, and that is deliberate:
 * consent governs this module's derivation, and turning it off does not turn off
 * a classifier that shipped two sprints before this contract existed. Hiding it
 * behind the toggle would make the screen lie in the exact case the user is most
 * likely to be looking.
 *
 * ── No clock ─────────────────────────────────────────────────────
 *
 * `now` is a parameter at every level. Two presenters given the same stores and
 * the same instant produce deep-equal views, and a test pins that.
 */
import {
  OPERATIVE_CONFIDENCE_FLOOR,
  PERSONALIZATION_WINDOW_LADDER_DAYS,
  PREFERENCE_DIMENSIONS,
  PRODUCT_BASELINE_LEVELS,
  checkPersonalizationProfile,
  type Instant,
  type PersonalizationBasisRung,
  type PersonalizationConsentState,
  type PersonalizationProfile,
  type PreferenceDimension,
  type PreferenceEvidence,
  type PreferenceReading,
} from '../../src/contracts/v1/personalizationContracts';
import { aggregateFeedback } from '../feedback/feedbackAggregation';
import type { FeedbackOutcome } from '../../src/contracts/v1/feedbackContracts';
import { getAdaptiveBehavior, normalizeAdaptiveSignals } from '../services/adaptiveService';
import type { AdaptivePressureLevel, AdaptiveSuggestionStyle, AdaptiveUserType } from '../services/adaptiveService';
import { readCorrections, type CorrectionEntry } from './correction';
import type { PersonalizationControlsPort } from './controlsPort';

/* ── Deriving, with the consent gate in front of the deriver ─────── */

export type PersonalizationDerivation =
  | { readonly kind: 'derived'; readonly profile: PersonalizationProfile }
  | { readonly kind: 'disabled'; readonly profile: PersonalizationProfile }
  | { readonly kind: 'deriver_unavailable' }
  | { readonly kind: 'profile_invalid'; readonly defectCodes: readonly string[] };

/**
 * Reads consent **first**, and only then touches the deriver.
 *
 * That order is the immediacy guarantee, and it is an ordering rather than a
 * cache invalidation on purpose. There is no stored profile for a consent flip
 * to race, because a disabled scope never produces one: the deriver is not
 * called at all, so there is nothing to forget. A test asserts the call count
 * does not move across the flip — which is a stronger statement than "the cache
 * was cleared", since it holds for a cache that was never written.
 */
export function derivePersonalizationProfile(
  port: PersonalizationControlsPort,
  scopeId: string,
  now: Instant,
): PersonalizationDerivation {
  const consent = port.consent.read(scopeId);
  if (consent.state !== 'enabled') {
    return {
      kind: 'disabled',
      profile: {
        version: 'personalization-v1' as PersonalizationProfile['version'],
        schemaVersion: 'personalization-v1',
        scopeId,
        consent: 'disabled',
        derivedAt: now,
        readings: null,
        basis: null,
      } as PersonalizationProfile,
    };
  }
  if (port.deriver === null) return { kind: 'deriver_unavailable' };

  const events = port.feedback.list({ scopeId, includeRevoked: true });
  const baseline = port.feedback.readBaseline(scopeId);
  const profile = port.deriver({
    scopeId,
    now,
    consent,
    rungAggregates: PERSONALIZATION_WINDOW_LADDER_DAYS.map((windowDays) =>
      aggregateFeedback({ events, baseline, scopeId, now, windowDays }),
    ),
  });

  const defects = checkPersonalizationProfile(profile);
  if (defects.length > 0) {
    return { kind: 'profile_invalid', defectCodes: defects.map((defect) => defect.code) };
  }
  return { kind: 'derived', profile };
}

/* ── Plain language ──────────────────────────────────────────────── */

/**
 * Past tense, user-facing. The outcome vocabulary is the store's, which is not
 * a vocabulary anyone should have to read on a settings screen.
 */
const OUTCOME_PHRASES: Readonly<Record<FeedbackOutcome, string>> = Object.freeze({
  accept: 'accepted',
  edit: 'reshaped',
  reject: 'declined',
  defer: 'postponed',
  complete: 'completed',
  ignore: 'left alone',
  undo: 'undone',
});

const DIMENSION_LABELS: Readonly<Record<PreferenceDimension, string>> = Object.freeze({
  pressure_ceiling: 'how insistent reminders may get',
  pressure_tone: 'the tone of a nudge',
  suggestion_directness: 'how directly suggestions are put',
  reminder_density: 'how many reminders you see',
});

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function describeEvidence(evidence: readonly PreferenceEvidence[]): string {
  if (evidence.length === 0) return 'no activity of the kind this reads';
  return evidence
    .map((entry) => {
      const days = PERSONALIZATION_WINDOW_LADDER_DAYS[entry.rungIndex] ?? 0;
      return `${entry.count} ${OUTCOME_PHRASES[entry.outcome]} within ${days} days`;
    })
    .join('; ');
}

function provenanceFor(reading: PreferenceReading): string {
  if (reading.status === 'inconclusive') {
    return `Not enough seen yet to say anything about ${DIMENSION_LABELS[reading.dimension]}.`;
  }
  return `Read from ${describeEvidence(reading.evidence)}.`;
}

function confidenceExplanationFor(reading: PreferenceReading): string {
  const floor = percent(OPERATIVE_CONFIDENCE_FLOOR);
  if (reading.confidence === null) return `Nothing is being changed; ${floor} agreement is the bar.`;
  const share = percent(reading.confidence);
  return reading.status === 'operative'
    ? `${share} of what you did points this way, at or above the ${floor} needed before anything changes.`
    : `${share} of what you did points this way, below the ${floor} needed before anything changes.`;
}

function whatWouldChangeItFor(reading: PreferenceReading): string {
  const subject = DIMENSION_LABELS[reading.dimension];
  if (reading.status === 'operative') {
    return `Setting ${subject} yourself replaces this. Behaving differently moves it over time.`;
  }
  if (reading.status === 'suggestion') {
    return `This is a suggestion only and changes nothing on its own. Setting ${subject} yourself decides it now.`;
  }
  return `Setting ${subject} yourself decides it now, or it settles once there is more to read.`;
}

/* ── Effective level ─────────────────────────────────────────────── */

export type EffectiveSource = 'user_correction' | 'derived_operative' | 'product_default';

export interface EffectivePreference {
  readonly source: EffectiveSource;
  readonly level: string;
}

function effectiveFor(
  dimension: PreferenceDimension,
  reading: PreferenceReading | null,
  correction: CorrectionEntry | null,
): EffectivePreference {
  if (correction !== null) return { source: 'user_correction', level: correction.level };
  if (reading !== null && reading.status === 'operative') {
    return { source: 'derived_operative', level: reading.level as string };
  }
  return { source: 'product_default', level: PRODUCT_BASELINE_LEVELS[dimension] };
}

/* ── The view ────────────────────────────────────────────────────── */

export interface InventoryReadingView {
  readonly status: PreferenceReading['status'];
  readonly level: string | null;
  readonly confidence: number | null;
  readonly sampleEventCount: number;
  readonly provenance: string;
  readonly confidenceExplanation: string;
  readonly whatWouldChangeIt: string;
}

export interface InventoryPreferenceRow {
  readonly dimension: PreferenceDimension;
  readonly label: string;
  /** Null whenever no valid reading exists — disabled, unwired, or rejected. */
  readonly reading: InventoryReadingView | null;
  readonly correction: CorrectionEntry | null;
  readonly effective: EffectivePreference;
}

export type InventoryPreferences =
  | { readonly kind: 'derived'; readonly rows: readonly InventoryPreferenceRow[]; readonly basis: readonly PersonalizationBasisRung[] }
  | { readonly kind: 'disabled'; readonly rows: readonly InventoryPreferenceRow[]; readonly explanation: string }
  | { readonly kind: 'deriver_unavailable'; readonly rows: readonly InventoryPreferenceRow[]; readonly explanation: string }
  | { readonly kind: 'profile_invalid'; readonly rows: readonly InventoryPreferenceRow[]; readonly defectCodes: readonly string[]; readonly explanation: string };

export interface InventoryMemoryRow {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly status: string;
  readonly source: string;
  readonly observedAt: string;
  readonly canRevoke: boolean;
}

export interface InventoryAdaptiveInput {
  readonly name: string;
  readonly label: string;
  readonly value: number;
  readonly valueLabel: string;
  readonly explanation: string;
}

export interface InventoryAdaptiveView {
  readonly classification: AdaptiveUserType;
  readonly classificationLabel: string;
  readonly explanation: string;
  readonly inputs: readonly InventoryAdaptiveInput[];
  readonly effect: {
    readonly pressureLevel: AdaptivePressureLevel;
    readonly suggestionStyle: AdaptiveSuggestionStyle;
  };
  readonly visibilityNote: string;
}

export interface PersonalizationInventoryView {
  readonly scopeId: string;
  readonly generatedAt: Instant;
  readonly consent: { readonly state: PersonalizationConsentState; readonly changedAt: string | null };
  readonly preferences: InventoryPreferences;
  readonly memory: { readonly records: readonly InventoryMemoryRow[] };
  readonly feedback: {
    readonly totalEvents: number;
    readonly revokedEvents: number;
    readonly outcomes: readonly { readonly outcome: FeedbackOutcome; readonly count: number }[];
  };
  readonly adaptive: InventoryAdaptiveView;
}

const ADAPTIVE_LABELS: Readonly<Record<AdaptiveUserType, string>> = Object.freeze({
  avoidant: 'Avoidant',
  inconsistent: 'Inconsistent',
  disciplined: 'Disciplined',
});

const ADAPTIVE_INPUT_COPY = Object.freeze([
  {
    name: 'ignoredCommitments',
    key: 'ignoredCommitmentsCount',
    label: 'Commitments left alone',
    explanation: 'How many things you were reminded about and did not act on.',
    asPercent: false,
  },
  {
    name: 'completionRate',
    key: 'completionRate',
    label: 'Completion rate',
    explanation: 'The share of things you started that you finished.',
    asPercent: true,
  },
  {
    name: 'delayFrequency',
    key: 'delayFrequency',
    label: 'How often things move',
    explanation: 'The share of commitments you postponed at least once.',
    asPercent: true,
  },
  {
    name: 'clarificationFrequency',
    key: 'clarificationFrequency',
    label: 'How often we ask again',
    explanation: 'The share of captures that needed a follow-up question.',
    asPercent: true,
  },
] as const);

function adaptiveView(port: PersonalizationControlsPort): InventoryAdaptiveView {
  const signals = port.readAdaptiveSignals();
  const normalized = normalizeAdaptiveSignals(signals);
  const behavior = getAdaptiveBehavior(signals);
  return {
    classification: behavior.userType,
    classificationLabel: ADAPTIVE_LABELS[behavior.userType],
    explanation:
      `The product sorts you into one of three groups from your own activity, and the group decides how much ` +
      `pressure a reminder may carry and how directly it is worded. Yours is "${ADAPTIVE_LABELS[behavior.userType]}".`,
    inputs: ADAPTIVE_INPUT_COPY.map((entry) => {
      const value = normalized[entry.key];
      return {
        name: entry.name,
        label: entry.label,
        value,
        valueLabel: entry.asPercent ? percent(value) : String(value),
        explanation: entry.explanation,
      };
    }),
    effect: { pressureLevel: behavior.pressureLevel, suggestionStyle: behavior.suggestionStyle },
    visibilityNote:
      'This classification is a label the product applies to you. It is shown here so you can see it and ' +
      'disagree with it; it is set from behaviour rather than from anything you asked for.',
  };
}

function readingView(reading: PreferenceReading): InventoryReadingView {
  return {
    status: reading.status,
    level: reading.level as string | null,
    confidence: reading.confidence,
    sampleEventCount: reading.sampleEventCount,
    provenance: provenanceFor(reading),
    confidenceExplanation: confidenceExplanationFor(reading),
    whatWouldChangeIt: whatWouldChangeItFor(reading),
  };
}

function rowsFor(
  readingOf: (dimension: PreferenceDimension) => PreferenceReading | null,
  corrections: ReturnType<typeof readCorrections>,
): readonly InventoryPreferenceRow[] {
  // Contract order, not sorted: `localeCompare` is forbidden here and a declared
  // order needs no comparator.
  return PREFERENCE_DIMENSIONS.map((dimension) => {
    const reading = readingOf(dimension);
    const correction = corrections[dimension];
    return {
      dimension,
      label: DIMENSION_LABELS[dimension],
      reading: reading === null ? null : readingView(reading),
      correction,
      effective: effectiveFor(dimension, reading, correction),
    };
  });
}

function preferencesFor(
  derivation: PersonalizationDerivation,
  corrections: ReturnType<typeof readCorrections>,
): InventoryPreferences {
  const none = () => null;
  switch (derivation.kind) {
    case 'derived': {
      const readings = derivation.profile.readings;
      return {
        kind: 'derived',
        rows: rowsFor((dimension) => (readings === null ? null : readings[dimension]), corrections),
        basis: derivation.profile.basis?.rungs ?? [],
      };
    }
    case 'disabled':
      return {
        kind: 'disabled',
        rows: rowsFor(none, corrections),
        explanation:
          'Personalization is off, so nothing is being learned from your activity. Anything you set yourself ' +
          'still applies.',
      };
    case 'deriver_unavailable':
      return {
        kind: 'deriver_unavailable',
        rows: rowsFor(none, corrections),
        explanation:
          'Personalization is on, but the part that learns preferences is not wired up in this build. Nothing ' +
          'has been inferred about you — this is not the same as having learned nothing.',
      };
    case 'profile_invalid':
      return {
        kind: 'profile_invalid',
        rows: rowsFor(none, corrections),
        defectCodes: derivation.defectCodes,
        explanation:
          'A preference profile was produced that does not satisfy its own contract, so none of it is being ' +
          'shown or applied.',
      };
  }
}

/** Assembles the whole view. Reads no clock; `now` is the only instant used. */
export function buildPersonalizationInventory(
  port: PersonalizationControlsPort,
  scopeId: string,
  now: Instant,
): PersonalizationInventoryView {
  const consent = port.consent.read(scopeId);
  const derivation = derivePersonalizationProfile(port, scopeId, now);
  const corrections = readCorrections(port.memory, scopeId, now);

  const events = port.feedback.list({ scopeId, includeRevoked: true });
  const counts = new Map<FeedbackOutcome, number>();
  let revokedEvents = 0;
  for (const event of events) {
    counts.set(event.outcome, (counts.get(event.outcome) ?? 0) + 1);
    if (typeof event.revokedAt === 'string' && event.revokedAt.length > 0) revokedEvents += 1;
  }

  return {
    scopeId,
    generatedAt: now,
    consent: { state: consent.state, changedAt: consent.changedAt },
    preferences: preferencesFor(derivation, corrections),
    memory: {
      records: port.memory.listAll(scopeId).map((record) => ({
        id: record.id,
        kind: record.kind,
        content: record.content,
        status: record.status,
        source: record.source,
        observedAt: record.observedAt,
        // Already-revoked and expired records cannot be revoked again; the
        // store refuses it, and offering the control anyway is a dead button.
        canRevoke: record.status === 'active' || record.status === 'superseded',
      })),
    },
    feedback: {
      totalEvents: events.length,
      revokedEvents,
      // Iteration order of the outcome vocabulary, not of the Map, so two runs
      // over the same events list the outcomes identically.
      outcomes: (Object.keys(OUTCOME_PHRASES) as FeedbackOutcome[])
        .filter((outcome) => counts.has(outcome))
        .map((outcome) => ({ outcome, count: counts.get(outcome) ?? 0 })),
    },
    adaptive: adaptiveView(port),
  };
}
