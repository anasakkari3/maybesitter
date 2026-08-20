/**
 * The personalization deriver (Sprint 10, issue #41, phase 2).
 *
 * Implements `PersonalizationDeriver` from `personalizationContracts`: rung
 * aggregates + explicit `now` + consent in, one `PersonalizationProfile` out.
 * Pure — no clock, no randomness, no I/O — so the reproducibility criterion
 * is a property of the function rather than a discipline of its callers.
 *
 * ── What the rules are allowed to conclude ───────────────────────────────
 *
 * Every rule below reads *weighted outcome shares* and nothing else. The
 * weight of an outcome is `Σ rungWeight · windowedCount` over the ladder
 * (`personalizationContracts` decision 3): an event in the newest window sits
 * in all three nested rungs and weighs 4+2+1 = 7, one older than 56 days
 * weighs 1, one beyond 224 days weighs nothing. That is the whole decay
 * mechanism, and it is why no rule here can see response latency: the input
 * has no per-event instants to read.
 *
 * The #107 asymmetry, as implemented rather than promised:
 *
 *   - `pressure_ceiling` derives `none` or `low` and **never above baseline**.
 *     A rejection majority is a statement about the product's interventions;
 *     an acceptance majority confirms the default. Nothing in an outcome mix
 *     is a request to be pushed harder, so v1 refuses to read one as such —
 *     escalation of pressure is reachable only through the correction surface
 *     (#42), where the user says it themselves.
 *   - `pressure_tone` is **never derived**: no outcome count distinguishes
 *     soft from firm. Its probative set is empty and every profile carries it
 *     as `inconclusive / no_admissible_evidence`. The contract's admissible
 *     set for tone is wider than this deriver's probative set on purpose —
 *     admissibility bounds what may ever be cited, probative is what v1
 *     actually finds meaningful, and the second is a subset of the first.
 *   - `suggestion_directness` may escalate exactly one step, to `supportive`,
 *     and only on an *edit* majority — the user repeatedly reshaping
 *     suggestions is explicit evidence the bare `minimal` form is not
 *     landing. `direct` is unreachable from v1 derivation, named here the way
 *     Sprint 08 named `defer`: in the vocabulary, excluded from production,
 *     so the reachability sweep can pin the exclusion instead of discovering
 *     it.
 *   - `reminder_density` de-escalates to `lean` on a disengagement majority
 *     (ignore/reject/undo — the behavioural outcomes are admissible for a
 *     presentation dimension) and confirms `standard` on an engagement
 *     majority. `rich` is unreachable from v1 derivation: acceptance is not a
 *     request for more volume. `defer` sits in neither basket — it is neither
 *     engagement nor disengagement — so a defer-heavy log dilutes both shares
 *     toward `conflicting_evidence`, which is the honest reading of it.
 *
 * Confidence **is** the winning share: a `0.8` means 80% of the weighted,
 * admissible evidence points at the stated level. It is never a probability
 * dressed up, and it inherits the contract's floors — below
 * `OPERATIVE_CONFIDENCE_FLOOR` or `MIN_OPERATIVE_SAMPLE_EVENTS` the reading
 * is a suggestion, below `MIN_SUGGESTION_SAMPLE_EVENTS` it is inconclusive.
 * The sample is counted in the *outermost* rung — distinct events over the
 * whole horizon — because the floors are about how much of the person we have
 * seen, not how recently.
 *
 * ── Failure directions ───────────────────────────────────────────────────
 *
 * Consent that is not affirmatively `enabled` — including unreadable consent
 * — yields the inert profile (`unreadableConsentIsDisabled`; fail-closed).
 * Malformed *structural* input — blank scope, unparseable `now`, aggregates
 * that do not match the ladder, the scope, or the instant — **throws**
 * `TypeError`, following `aggregateFeedback`: these are programming errors,
 * and an inert profile returned for one would read as "the user opted out"
 * while actually meaning "the caller passed garbage", which is the silent
 * misreport this module must never make about a person.
 */

import {
  EXPLICIT_JUDGEMENT_OUTCOMES,
  MIN_OPERATIVE_SAMPLE_EVENTS,
  MIN_SUGGESTION_SAMPLE_EVENTS,
  OPERATIVE_CONFIDENCE_FLOOR,
  PERSONALIZATION_CONTRACT_VERSION,
  PERSONALIZATION_EVIDENCE_OUTCOMES,
  PERSONALIZATION_RUNG_WEIGHTS,
  PERSONALIZATION_SCHEMA_VERSION,
  PERSONALIZATION_WINDOW_LADDER_DAYS,
  PREFERENCE_DIMENSIONS,
  inertPersonalizationProfile,
  isInstant,
  type FeedbackAggregates,
  type FeedbackOutcome,
  type Instant,
  type PersonalizationBasisRung,
  type PersonalizationDerivationInput,
  type PersonalizationDeriver,
  type PersonalizationProfile,
  type PreferenceDimension,
  type PreferenceEvidence,
  type PreferenceLevel,
  type PreferenceReading,
  type PreferenceReadings,
} from '../../src/contracts/v1/personalizationContracts';

/**
 * The share of weighted, probative evidence a rule demands before it states a
 * level. One named constant per decision site so each can be tuned — and
 * mutation-tested — independently; all are majorities today, and the contract
 * suite pins that no rule may ever claim a level on a minority.
 *
 *  - `pressureOffShare`: reject+undo share at or above which the ceiling is
 *    `none`. Half, because "half of everything this person explicitly judged,
 *    they pushed away" is the point where continuing to press stops being a
 *    default and starts being a decision — and below the operative confidence
 *    floor the result is only ever a suggestion anyway.
 *  - `directnessSupportiveShare`: edit share at or above which directness is
 *    `supportive`.
 *  - `minimalConfirmationShare`: accept share confirming `minimal`.
 *  - `densityLeanShare`: ignore+reject+undo share at or above which density
 *    is `lean`.
 *  - `standardConfirmationShare`: accept+edit+complete share confirming
 *    `standard`.
 */
export const DERIVATION_SHARE_RULES = Object.freeze({
  pressureOffShare: 0.5,
  directnessSupportiveShare: 0.5,
  minimalConfirmationShare: 0.5,
  densityLeanShare: 0.5,
  standardConfirmationShare: 0.5,
});

/**
 * What v1 actually reads per dimension — a subset of the contract's
 * admissible sets, never a superset (`tests/personalization` proves the
 * containment). Tone's is empty: see the header.
 */
export const PROBATIVE_OUTCOMES: Readonly<Record<PreferenceDimension, readonly FeedbackOutcome[]>> =
  Object.freeze({
    pressure_ceiling: EXPLICIT_JUDGEMENT_OUTCOMES,
    pressure_tone: Object.freeze([]),
    suggestion_directness: EXPLICIT_JUDGEMENT_OUTCOMES,
    reminder_density: PERSONALIZATION_EVIDENCE_OUTCOMES,
  });

/**
 * Levels in the vocabulary that v1 derivation can never produce, stated as
 * data the way Sprint 08 stated `VERDICT_ONLY_ACTION_KINDS`: a reachability
 * sweep needs the exclusion named, or an unreachable outcome is invisible to
 * every assertion about the thing itself. The correction surface (#42) is the
 * only path to these.
 */
export const UNDERIVABLE_LEVELS: Readonly<Record<PreferenceDimension, readonly string[]>> =
  Object.freeze({
    pressure_ceiling: Object.freeze(['medium', 'high']),
    pressure_tone: Object.freeze(['soft', 'firm']),
    suggestion_directness: Object.freeze(['direct']),
    reminder_density: Object.freeze(['rich']),
  });

/* ── Input validation ────────────────────────────────────────────── */

function requireScopeId(scopeId: unknown): string {
  if (typeof scopeId !== 'string' || scopeId.trim().length === 0) {
    throw new TypeError('derivePersonalizationProfile: scopeId must be a non-empty string');
  }
  return scopeId;
}

function requireNow(now: unknown): Instant {
  if (!isInstant(now)) {
    throw new TypeError(
      `derivePersonalizationProfile: now must be a well-formed instant, received ${JSON.stringify(now ?? null)}`,
    );
  }
  return now;
}

/**
 * The aggregates must be exactly the ladder, for this scope, at this instant.
 * Anything else is a caller wiring error: an aggregate computed yesterday or
 * for another user would produce a profile that looks valid and quietly fails
 * to replay, which is the precise defect `aggregateFeedback` throws for.
 */
function requireRungAggregates(
  aggregates: readonly FeedbackAggregates[],
  scopeId: string,
  now: Instant,
): readonly FeedbackAggregates[] {
  if (!Array.isArray(aggregates) || aggregates.length !== PERSONALIZATION_WINDOW_LADDER_DAYS.length) {
    throw new TypeError(
      `derivePersonalizationProfile: expected one aggregate per ladder rung (${PERSONALIZATION_WINDOW_LADDER_DAYS.length}), received ${Array.isArray(aggregates) ? aggregates.length : typeof aggregates}`,
    );
  }
  for (let index = 0; index < aggregates.length; index += 1) {
    const aggregate = aggregates[index];
    const expectedDays = PERSONALIZATION_WINDOW_LADDER_DAYS[index];
    if (aggregate === null || aggregate === undefined || typeof aggregate !== 'object') {
      throw new TypeError(`derivePersonalizationProfile: rung ${index} is not an aggregate`);
    }
    if (aggregate.windowDays !== expectedDays) {
      throw new TypeError(
        `derivePersonalizationProfile: rung ${index} covers ${aggregate.windowDays} days, the ladder requires ${expectedDays}`,
      );
    }
    if (aggregate.scopeId !== scopeId) {
      throw new TypeError(
        `derivePersonalizationProfile: rung ${index} belongs to another scope`,
      );
    }
    if (aggregate.computedAt !== now) {
      throw new TypeError(
        `derivePersonalizationProfile: rung ${index} was computed at ${JSON.stringify(aggregate.computedAt)}, not at the derivation instant`,
      );
    }
  }
  return aggregates;
}

/* ── Weighted shares ─────────────────────────────────────────────── */

interface DimensionSignals {
  /** Ladder-weighted count per probative outcome. */
  readonly weighted: Readonly<Partial<Record<FeedbackOutcome, number>>>;
  /** Sum of `weighted` over the probative set. */
  readonly weightedTotal: number;
  /** Distinct probative events over the whole horizon (outermost rung). */
  readonly sampleEventCount: number;
  /** Rung-major, outcome-order evidence entries, counts >= 1 only. */
  readonly evidence: readonly PreferenceEvidence[];
}

function signalsFor(
  rungs: readonly FeedbackAggregates[],
  probative: readonly FeedbackOutcome[],
): DimensionSignals {
  const weighted: Partial<Record<FeedbackOutcome, number>> = {};
  const evidence: PreferenceEvidence[] = [];
  let weightedTotal = 0;

  for (let rungIndex = 0; rungIndex < rungs.length; rungIndex += 1) {
    const windowed = rungs[rungIndex].windowed;
    const weight = PERSONALIZATION_RUNG_WEIGHTS[rungIndex];
    // Outcome iteration follows the contract's frozen outcome order, so the
    // evidence a profile carries serializes identically for identical logs.
    for (const outcome of PERSONALIZATION_EVIDENCE_OUTCOMES) {
      if (!probative.includes(outcome)) continue;
      const count = windowed[outcome] ?? 0;
      if (count < 1) continue;
      weighted[outcome] = (weighted[outcome] ?? 0) + weight * count;
      weightedTotal += weight * count;
      evidence.push({ rungIndex, outcome, count });
    }
  }

  const outermost = rungs[rungs.length - 1].windowed;
  let sampleEventCount = 0;
  for (const outcome of probative) {
    sampleEventCount += outermost[outcome] ?? 0;
  }

  return { weighted, weightedTotal, sampleEventCount, evidence };
}

function share(signals: DimensionSignals, outcomes: readonly FeedbackOutcome[]): number {
  if (signals.weightedTotal === 0) return 0;
  let sum = 0;
  for (const outcome of outcomes) {
    sum += signals.weighted[outcome] ?? 0;
  }
  return sum / signals.weightedTotal;
}

/* ── Per-dimension level rules ───────────────────────────────────── */

/** A level claim with the weighted share standing behind it, or null for conflict. */
interface LevelClaim {
  readonly level: string;
  readonly support: number;
}

function ceilingRule(signals: DimensionSignals): LevelClaim | null {
  const negative = share(signals, ['reject', 'undo']);
  if (negative >= DERIVATION_SHARE_RULES.pressureOffShare) {
    return { level: 'none', support: negative };
  }
  // A binary choice: everything not objecting stands behind the baseline, so
  // one side always holds a majority and the ceiling is never `conflicting`.
  //
  // Spelled as the complement *set* rather than `1 - negative`, which is the
  // same number in arithmetic and not always the same float. On 3 accepts at
  // age 1 against 10 rejects at age 100 the two differ by one unit in the last
  // place — `1 - 10/31` is 0.6774193548387097, `21/31` is 0.6774193548387096 —
  // because floating-point subtraction does not associate with division.
  //
  // That is not cosmetic here. `support` becomes `confidence`, and confidence
  // is compared against `OPERATIVE_CONFIDENCE_FLOOR` with `>=`. A reading whose
  // true share sits exactly on the floor would be `operative` computed one way
  // and `suggestion` computed the other, so the arithmetic path would decide
  // whether a preference is allowed to change behaviour. Every share now comes
  // from `share()` over an explicit outcome set, so there is one path and it is
  // the one the tests state.
  return { level: 'low', support: share(signals, ['accept', 'edit']) };
}

function directnessRule(signals: DimensionSignals): LevelClaim | null {
  const editing = share(signals, ['edit']);
  if (editing >= DERIVATION_SHARE_RULES.directnessSupportiveShare) {
    return { level: 'supportive', support: editing };
  }
  const accepting = share(signals, ['accept']);
  if (accepting >= DERIVATION_SHARE_RULES.minimalConfirmationShare) {
    return { level: 'minimal', support: accepting };
  }
  // Rejection-heavy: explicit dissatisfaction names no directness style.
  return null;
}

function densityRule(signals: DimensionSignals): LevelClaim | null {
  const disengaged = share(signals, ['ignore', 'reject', 'undo']);
  if (disengaged >= DERIVATION_SHARE_RULES.densityLeanShare) {
    return { level: 'lean', support: disengaged };
  }
  const engaged = share(signals, ['accept', 'edit', 'complete']);
  if (engaged >= DERIVATION_SHARE_RULES.standardConfirmationShare) {
    return { level: 'standard', support: engaged };
  }
  return null;
}

const LEVEL_RULES: Readonly<
  Record<PreferenceDimension, (signals: DimensionSignals) => LevelClaim | null>
> = Object.freeze({
  pressure_ceiling: ceilingRule,
  // Tone has an empty probative set, so this rule is unreachable; stating it
  // as "no claim" keeps the dispatch total rather than partially defined.
  pressure_tone: () => null,
  suggestion_directness: directnessRule,
  reminder_density: densityRule,
});

/* ── Reading assembly ────────────────────────────────────────────── */

function deriveReading<D extends PreferenceDimension>(
  dimension: D,
  rungs: readonly FeedbackAggregates[],
  totalHorizonEvents: number,
): PreferenceReading<D> {
  const probative = PROBATIVE_OUTCOMES[dimension];
  const signals = signalsFor(rungs, probative);

  const inconclusive = (reason: 'insufficient_sample' | 'conflicting_evidence' | 'no_admissible_evidence') =>
    ({
      status: 'inconclusive',
      dimension,
      reason,
      level: null,
      confidence: null,
      sampleEventCount: signals.sampleEventCount,
      evidence: signals.evidence,
    }) as PreferenceReading<D>;

  if (signals.sampleEventCount === 0) {
    // Nothing probative. If the horizon holds events at all, the honest reason
    // is that none of them may be read for this dimension; an empty horizon is
    // simply too little of the person seen.
    return inconclusive(totalHorizonEvents > 0 ? 'no_admissible_evidence' : 'insufficient_sample');
  }
  if (signals.sampleEventCount < MIN_SUGGESTION_SAMPLE_EVENTS) {
    return inconclusive('insufficient_sample');
  }

  const claim = LEVEL_RULES[dimension](signals);
  if (claim === null) {
    return inconclusive('conflicting_evidence');
  }

  const confidence = Math.min(1, Math.max(0, claim.support));
  const operative =
    confidence >= OPERATIVE_CONFIDENCE_FLOOR &&
    signals.sampleEventCount >= MIN_OPERATIVE_SAMPLE_EVENTS &&
    signals.evidence.length >= 1;

  // The single widening cast in this module: `claim.level` is produced by the
  // per-dimension rule table, whose outputs the contract suite pins against
  // `PREFERENCE_LEVEL_VOCABULARY[dimension]`, and every derived profile is
  // checker-verified in the tests — the cast is bookkeeping, not trust.
  const level = claim.level as PreferenceLevel<D>;

  if (operative) {
    const [first, ...rest] = signals.evidence;
    return {
      status: 'operative',
      dimension,
      reason: null,
      level,
      confidence,
      sampleEventCount: signals.sampleEventCount,
      evidence: [first, ...rest],
    } as PreferenceReading<D>;
  }

  return {
    status: 'suggestion',
    dimension,
    reason: null,
    level,
    confidence,
    sampleEventCount: signals.sampleEventCount,
    evidence: signals.evidence,
  } as PreferenceReading<D>;
}

/* ── The deriver ─────────────────────────────────────────────────── */

export const derivePersonalizationProfile: PersonalizationDeriver = (
  input: PersonalizationDerivationInput,
): PersonalizationProfile => {
  if (input === null || input === undefined || typeof input !== 'object') {
    throw new TypeError('derivePersonalizationProfile: input must be an object');
  }
  const scopeId = requireScopeId(input.scopeId);
  const now = requireNow(input.now);

  // The consent gate comes before the aggregates are even looked at: a
  // disabled person's path must not depend on the correctness of data the
  // product had no business deriving from.
  const consentState =
    input.consent === null || input.consent === undefined ? undefined : input.consent.state;
  if (consentState !== 'enabled') {
    return inertPersonalizationProfile(scopeId, now);
  }

  const rungs = requireRungAggregates(input.rungAggregates, scopeId, now);

  const basisRungs: PersonalizationBasisRung[] = rungs.map((aggregate) => ({
    windowDays: aggregate.windowDays,
    windowStart: aggregate.windowStart as Instant,
    inputDigest: aggregate.inputDigest,
    revokedCount: aggregate.revokedCount,
  }));

  const outermost = rungs[rungs.length - 1].windowed;
  let totalHorizonEvents = 0;
  for (const outcome of PERSONALIZATION_EVIDENCE_OUTCOMES) {
    totalHorizonEvents += outermost[outcome] ?? 0;
  }

  const readings = Object.fromEntries(
    PREFERENCE_DIMENSIONS.map((dimension) => [
      dimension,
      deriveReading(dimension, rungs, totalHorizonEvents),
    ]),
  ) as PreferenceReadings;

  return {
    version: PERSONALIZATION_CONTRACT_VERSION,
    schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
    scopeId,
    consent: 'enabled',
    derivedAt: now,
    basis: { scopeId, rungs: basisRungs },
    readings,
  };
};
