/**
 * The go / hold / rollback evidence package generator (Sprint 11, issue #47).
 *
 * ── Three pillars, or nothing ────────────────────────────────────
 *
 * `ShadowEvidencePackage.evidence` is a **total record** over
 * `ShadowEvidencePillar`, and every pillar's bundle is a non-empty tuple. So a
 * package missing quality, safety or reliability does not compile. This module
 * therefore never omits a pillar — when a pillar's source is not wired it emits
 * an item that *says so*, with `support: 'inconclusive'` and a citation naming
 * who owns the missing input. "Not available" is a finding; a silently absent
 * pillar is a lie that reads as agreement.
 *
 * ── The engagement rule, made structural ─────────────────────────
 *
 * `NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE` is #41's invariant and
 * `SHADOW_RELEASE_GATE_INVARIANT` is the same string. It is enforced here by
 * the **shape of the input**, not by a check on the output:
 *
 *   - A `ShadowPillarFinding` — the only input that carries a `disposition`,
 *     and therefore the only input that can become a `go` — has a
 *     `measureClass` typed as `ShadowJudgementMeasureClass`, which is
 *     `ShadowMeasureClass` minus `SHADOW_ENGAGEMENT_MEASURE_CLASSES`. An
 *     engagement finding does not typecheck.
 *   - A `ShadowEngagementObservation` has **no disposition field at all**. It
 *     becomes an item with `support: 'inconclusive'`, always. There is no
 *     value a caller can put in it that argues for anything.
 *
 * So "a decision derivable from engagement measures alone" is not something the
 * generator refuses; it is something a caller cannot express. Sprint 10's
 * reason, verbatim from #107: a signal that a user responded faster is not
 * evidence that the product helped them, and a loop that rewards quick
 * responses learns to produce anxiety.
 *
 * ── The asymmetries, matching `evaluateRollbackGate` ─────────────
 *
 * Deliberately the same three as #43's gate, because a release decision that
 * used a second, gentler arithmetic than the rollback gate would be a way to
 * ship what the gate refused:
 *
 *   1. **Any harm alone refuses.** One `harm` finding in any pillar makes the
 *      package `rollback`, however small the pillar and however many benefits
 *      sit beside it. The count of benefits is never compared to the count of
 *      harms — there is no arithmetic in which a benefit can win, because a
 *      gate that can be outvoted by a benefit ships harm once the benefit
 *      number is large enough.
 *   2. **A concern holds.** `hold` is the honest default and the commonest
 *      answer.
 *   3. **Evidence that is not from real exposure can refuse and can never
 *      authorise.** A `benefit` finding whose source provenance is not
 *      `real_exposure` is emitted as `inconclusive`; a `harm` finding from the
 *      same source is emitted as `rollback`. Simulation can falsify, it cannot
 *      authorise — `evaluateRollbackGate`'s exact asymmetry, and the reason
 *      Sprint 04's empty corpus and Sprint 06's synthetic dataset both became
 *      "our results" the moment somebody quoted a number.
 *
 * A fourth, from the contract: a `benefit` resting on an *inconclusive* SLO
 * reading is also emitted as `inconclusive`. "We could not measure it" is not
 * "it is fine", and the contract has a defect code
 * (`EVIDENCE_SUPPORTS_GO_ON_INCONCLUSIVE_SLO`) for a producer that disagrees.
 *
 * ── What this generator can and cannot assemble today ────────────
 *
 * The quality pillar is wired to #43's `buildEvaluationReport` /
 * `evaluateRollbackGate` and to this sprint's own study summary. The safety and
 * reliability pillars are **typed seams**: #46's SLO readings and #45's traces
 * do not exist yet, so a caller with nothing to pass calls
 * `unavailablePillarSource` and the package says "not available" in that pillar
 * rather than pretending. Pointing it at real data is passing a different
 * source object; nothing here is fixture-specific.
 */
import {
  MIN_SLO_SAMPLE_COUNT,
  PERSONALIZATION_INVARIANTS,
  SHADOW_ENGAGEMENT_MEASURE_CLASSES,
  SHADOW_EVIDENCE_PILLARS,
  SHADOW_EXPOSURE_STAGES,
  SHADOW_MEASURE_CLASSES,
  SHADOW_PIPELINE_CONTRACT_VERSION,
  SHADOW_PIPELINE_SCHEMA_VERSION,
  SHADOW_RELEASE_GATE_INVARIANT,
  SHADOW_SAFE_CODE,
  SHADOW_STUDY_RATING_SCALE,
  checkShadowEvidencePackage,
  isInstant,
  type Instant,
  type ShadowEvidenceBundle,
  type ShadowEvidenceItem,
  type ShadowEvidencePackage,
  type ShadowEvidencePillar,
  type ShadowExposureStage,
  type ShadowMeasureClass,
  type ShadowPipelineDefect,
  type ShadowReleaseDecision,
  type ShadowSloReading,
  type ShadowStudyQuestionId,
} from '../../src/contracts/v1/shadowPipelineContracts';
import {
  HARM_SIGNALS,
  evaluateRollbackGate,
  type PersonalizationEvaluationReport,
} from '../evaluation/personalization/report';
import type { ShadowStudySummary } from './study';

/* ── Provenance: who may authorise ───────────────────────────────── */

export type ShadowEvidenceProvenance = 'real_exposure' | 'simulated' | 'unavailable';

export const SHADOW_EVIDENCE_PROVENANCES = Object.freeze([
  'real_exposure',
  'simulated',
  'unavailable',
] as const) satisfies readonly ShadowEvidenceProvenance[];

/**
 * The provenances a `go` may rest on. A list rather than an inline comparison,
 * so the rule has a name a diff can be held against — the
 * `FORBIDDEN_DERIVATION_SIGNALS` pattern, and `RELEASE_GATE_SIGNALS`'s.
 */
export const SHADOW_AUTHORISING_PROVENANCES = Object.freeze([
  'real_exposure',
] as const) satisfies readonly ShadowEvidenceProvenance[];

export function provenanceMayAuthorise(provenance: ShadowEvidenceProvenance): boolean {
  return (SHADOW_AUTHORISING_PROVENANCES as readonly string[]).includes(provenance);
}

/* ── Findings: the only inputs that can argue ────────────────────── */

export type ShadowFindingDisposition = 'benefit' | 'concern' | 'harm' | 'inconclusive';

export const SHADOW_FINDING_DISPOSITIONS = Object.freeze([
  'benefit',
  'concern',
  'harm',
  'inconclusive',
] as const) satisfies readonly ShadowFindingDisposition[];

/** `ShadowMeasureClass` minus the engagement classes. See the header. */
export type ShadowJudgementMeasureClass = Exclude<
  ShadowMeasureClass,
  (typeof SHADOW_ENGAGEMENT_MEASURE_CLASSES)[number]
>;

export const SHADOW_JUDGEMENT_MEASURE_CLASSES = Object.freeze(
  SHADOW_MEASURE_CLASSES.filter(
    (measureClass): measureClass is ShadowJudgementMeasureClass =>
      !(SHADOW_ENGAGEMENT_MEASURE_CLASSES as readonly string[]).includes(measureClass),
  ),
);

export interface ShadowPillarFinding {
  readonly measureClass: ShadowJudgementMeasureClass;
  readonly disposition: ShadowFindingDisposition;
  readonly citation: string;
  readonly sloReading: ShadowSloReading | null;
}

/**
 * An engagement measure, as context.
 *
 * No `disposition`, no `support`, no `measureClass` — it is always
 * `'engagement'` and always `support: 'inconclusive'`. It exists so engagement
 * numbers can appear in the decision record at all, where
 * `GO_RESTS_ON_ENGAGEMENT_ALONE` can see them, rather than being kept out of
 * the package and quoted in the meeting instead.
 */
export interface ShadowEngagementObservation {
  readonly citation: string;
  readonly sloReading: ShadowSloReading | null;
}

export interface ShadowPillarSource {
  readonly provenance: ShadowEvidenceProvenance;
  readonly findings: readonly ShadowPillarFinding[];
  readonly engagementContext: readonly ShadowEngagementObservation[];
  /**
   * Who has to land before this pillar can be measured. Only meaningful for an
   * `unavailable` source, where it becomes part of the citation so the package
   * says *which* input is missing rather than only that one is.
   */
  readonly owner?: string;
}

/** The class a pillar's "not available" placeholder is filed under. */
export const SHADOW_PILLAR_PRIMARY_MEASURE_CLASS: Readonly<
  Record<ShadowEvidencePillar, ShadowJudgementMeasureClass>
> = Object.freeze({
  quality: 'user_judgement',
  safety: 'safety_outcome',
  reliability: 'reliability_signal',
});

/**
 * A pillar nobody has wired yet.
 *
 * `owner` reaches the package as part of the citation, so the decision record
 * says *which* input is missing rather than "inconclusive".
 */
export function unavailablePillarSource(owner: string): ShadowPillarSource {
  return { provenance: 'unavailable', findings: [], engagementContext: [], owner };
}

/* ── The generator ───────────────────────────────────────────────── */

export interface ShadowEvidencePackageInput {
  readonly packageId: string;
  /** From the caller. This module never reads a clock. */
  readonly assembledAt: Instant;
  readonly stage: ShadowExposureStage;
  readonly sources: Readonly<Record<ShadowEvidencePillar, ShadowPillarSource>>;
}

export const SHADOW_PACKAGE_REFUSALS = Object.freeze([
  'unsafe_package_id',
  'malformed_instant',
  'unknown_stage',
  'missing_pillar_source',
  'unavailable_source_carries_findings',
] as const);

export type ShadowPackageRefusal = (typeof SHADOW_PACKAGE_REFUSALS)[number];

export type ShadowEvidencePackageOutcome =
  | {
      readonly status: 'assembled';
      readonly package: ShadowEvidencePackage;
      /** `checkShadowEvidencePackage`'s findings. Empty for a clean package. */
      readonly defects: readonly ShadowPipelineDefect[];
      readonly unavailablePillars: readonly ShadowEvidencePillar[];
      readonly rationale: readonly string[];
    }
  | { readonly status: 'refused'; readonly reason: ShadowPackageRefusal; readonly detail: string };

function isSafeCode(value: unknown): value is string {
  return typeof value === 'string' && SHADOW_SAFE_CODE.test(value);
}

/**
 * One finding's support.
 *
 * The two downgrades are the whole asymmetry: a `benefit` whose provenance
 * cannot authorise, and a `benefit` resting on a reading that could not be
 * measured, both become `inconclusive`. A `harm` is never downgraded by either,
 * which is what "simulation can refuse but cannot authorise" means in code.
 */
function supportFor(
  finding: ShadowPillarFinding,
  provenance: ShadowEvidenceProvenance,
): ShadowEvidenceItem['support'] {
  switch (finding.disposition) {
    case 'harm':
      return 'rollback';
    case 'concern':
      return 'hold';
    case 'benefit': {
      if (!provenanceMayAuthorise(provenance)) return 'inconclusive';
      if (finding.sloReading !== null && finding.sloReading.status === 'inconclusive') return 'inconclusive';
      return 'go';
    }
    default:
      return 'inconclusive';
  }
}

function placeholderItem(pillar: ShadowEvidencePillar, citation: string): ShadowEvidenceItem {
  return {
    pillar,
    measureClass: SHADOW_PILLAR_PRIMARY_MEASURE_CLASS[pillar],
    support: 'inconclusive',
    sloReading: null,
    citation,
  };
}

/**
 * One pillar's items, as the contract's non-empty tuple.
 *
 * Non-empty by construction rather than by assertion: every branch produces a
 * head item before the engagement context is appended, so there is no path
 * where a cast or a throw would be needed to satisfy the tuple.
 */
function itemsForPillar(
  pillar: ShadowEvidencePillar,
  source: ShadowPillarSource,
): ShadowEvidenceBundle {
  const engagement: ShadowEvidenceItem[] = source.engagementContext.map((observation) => ({
    pillar,
    // Always engagement, always inconclusive. See the header.
    measureClass: 'engagement',
    support: 'inconclusive',
    sloReading: observation.sloReading,
    citation: observation.citation,
  }));

  if (source.provenance === 'unavailable') {
    const citation = isSafeCode(source.owner)
      ? `not_available.${source.owner}`.slice(0, 64)
      : `not_available.${pillar}`;
    return [placeholderItem(pillar, citation), ...engagement];
  }

  const [first, ...rest] = source.findings.map((finding) => ({
    pillar,
    measureClass: finding.measureClass,
    support: supportFor(finding, source.provenance),
    sloReading: finding.sloReading,
    citation: finding.citation,
  } satisfies ShadowEvidenceItem));

  if (first === undefined) {
    // Wired and found nothing. A different sentence from "not wired", and it
    // gets a different citation so a reader can tell them apart.
    return [placeholderItem(pillar, `no_findings.${pillar}`), ...engagement];
  }
  return [first, ...rest, ...engagement];
}

/**
 * Turns the pillar bundles into one decision.
 *
 * Read the order: `rollback` before `hold` before `go`, and `go` requires
 * something arguing for it in **every** pillar. There is no branch in which a
 * count of `go` items is compared against a count of `rollback` items.
 */
function decideRelease(
  bundles: Readonly<Record<ShadowEvidencePillar, readonly ShadowEvidenceItem[]>>,
): { decision: ShadowReleaseDecision; rationale: readonly string[] } {
  const rationale: string[] = [];

  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    for (const item of bundles[pillar]) {
      if (item.support === 'rollback') {
        rationale.push(`${pillar}: ${item.citation} says roll back; a harm alone decides, whatever sits beside it`);
      }
    }
  }
  if (rationale.length > 0) return { decision: 'rollback', rationale };

  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    for (const item of bundles[pillar]) {
      if (item.support === 'hold') {
        rationale.push(`${pillar}: ${item.citation} says hold`);
      }
    }
  }
  if (rationale.length > 0) return { decision: 'hold', rationale };

  const pillarsWithoutGo = SHADOW_EVIDENCE_PILLARS.filter(
    (pillar) => !bundles[pillar].some((item) => item.support === 'go'),
  );
  if (pillarsWithoutGo.length > 0) {
    return {
      decision: 'hold',
      rationale: pillarsWithoutGo.map(
        (pillar) => `${pillar}: nothing in this pillar supports going; "includes evidence" means evidence *for* the decision`,
      ),
    };
  }

  return {
    decision: 'go',
    rationale: ['every pillar carries non-engagement support for going, and nothing carries a harm or a concern'],
  };
}

/**
 * Assembles the package a go/hold/rollback decision is made from.
 *
 * Deterministic: same sources, same package. No clock, no randomness, no sort —
 * items appear in the order their source listed them, and pillars in
 * `SHADOW_EVIDENCE_PILLARS` order.
 */
export function buildEvidencePackage(
  input: ShadowEvidencePackageInput,
): ShadowEvidencePackageOutcome {
  if (!isSafeCode(input.packageId)) {
    return { status: 'refused', reason: 'unsafe_package_id', detail: `packageId is outside the safe-code pattern: ${String(input.packageId)}` };
  }
  if (!isInstant(input.assembledAt)) {
    return { status: 'refused', reason: 'malformed_instant', detail: `assembledAt is not an ISO instant with an explicit offset: ${String(input.assembledAt)}` };
  }
  if (!(SHADOW_EXPOSURE_STAGES as readonly string[]).includes(input.stage)) {
    return { status: 'refused', reason: 'unknown_stage', detail: `not an exposure stage: ${String(input.stage)}` };
  }
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const source = input.sources?.[pillar];
    if (source === undefined || source === null) {
      return { status: 'refused', reason: 'missing_pillar_source', detail: `no source was supplied for the ${pillar} pillar; use unavailablePillarSource to say so` };
    }
    if (source.provenance === 'unavailable' && source.findings.length > 0) {
      // A source that is both unavailable and full of findings disagrees with
      // itself, and picking one half for the caller is guessing which half
      // they meant.
      return { status: 'refused', reason: 'unavailable_source_carries_findings', detail: `the ${pillar} source is marked unavailable and carries ${source.findings.length} findings` };
    }
  }

  const bundles = {
    quality: itemsForPillar('quality', input.sources.quality),
    safety: itemsForPillar('safety', input.sources.safety),
    reliability: itemsForPillar('reliability', input.sources.reliability),
  } as const;

  const { decision, rationale } = decideRelease(bundles);

  const evidencePackage: ShadowEvidencePackage = {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    packageId: input.packageId,
    assembledAt: input.assembledAt,
    stage: input.stage,
    decision,
    evidence: bundles,
  };

  return {
    status: 'assembled',
    package: evidencePackage,
    // The contract's own checker, run on our own output. A generator that does
    // not check itself is a generator whose bugs reach the decision record.
    defects: checkShadowEvidencePackage(evidencePackage),
    unavailablePillars: SHADOW_EVIDENCE_PILLARS.filter(
      (pillar) => input.sources[pillar].provenance === 'unavailable',
    ),
    rationale,
  };
}

/**
 * The invariant this generator is responsible for, named so a test can
 * enumerate it against the contract's list rather than trusting this comment.
 * `GATE_ENFORCED_INVARIANTS` in #43's report does the same thing for the same
 * reason.
 */
export const PACKAGE_ENFORCED_INVARIANTS = Object.freeze(
  PERSONALIZATION_INVARIANTS.filter((invariant) => invariant === SHADOW_RELEASE_GATE_INVARIANT),
);

/* ── Wiring: the quality pillar (#43's report and this sprint's study) ── */

/**
 * #43's evaluation report, as quality evidence.
 *
 * The gate's verdict is carried through rather than re-derived: a second
 * arithmetic over the same readings is a second threshold, and the second one
 * is always the lenient one. `provenance` follows the report's own — a
 * synthetic cohort produces `simulated`, which can refuse and cannot authorise,
 * which is exactly what `evaluateRollbackGate` already says about it.
 *
 * Slice detail is deliberately *not* in the citations. `citation` is a
 * `SHADOW_SAFE_CODE` and slice ids are caller text; the narrative belongs in
 * the decision record, and this object carries what a checker can verify.
 */
export function qualityPillarFromEvaluationReport(
  report: PersonalizationEvaluationReport,
): ShadowPillarSource {
  const decision = evaluateRollbackGate(report);
  const provenance: ShadowEvidenceProvenance = report.provenance === 'real_logged' ? 'real_exposure' : 'simulated';

  if (decision.verdict === 'rollback') {
    // One finding per breached metric, in `HARM_SIGNALS` order — a closed
    // vocabulary, so the item count is bounded and the order needs no sort.
    const breached = HARM_SIGNALS.filter((metric) =>
      decision.reasons.some((reason) => reason.metric === metric));
    return {
      provenance,
      findings: breached.map((metric) => ({
        measureClass: 'user_judgement' as const,
        disposition: 'harm' as const,
        citation: `evaluation_gate.harm.${metric}`,
        sloReading: null,
      })),
      engagementContext: [],
    };
  }

  if (decision.verdict === 'keep') {
    return {
      provenance,
      findings: [{ measureClass: 'user_judgement', disposition: 'benefit', citation: 'evaluation_gate.keep', sloReading: null }],
      engagementContext: [],
    };
  }

  return {
    provenance,
    findings: [{ measureClass: 'user_judgement', disposition: 'inconclusive', citation: 'evaluation_gate.inconclusive', sloReading: null }],
    engagementContext: [],
  };
}

/**
 * How a study summary is read as evidence.
 *
 * Both numbers are **derived from constants that already exist**, not chosen:
 *
 *   - `neutralRating` is the midpoint of `SHADOW_STUDY_RATING_SCALE`. A mean
 *     strictly above it is a benefit reading, strictly below is a concern, and
 *     exactly at it is inconclusive — a scale's own middle is the one
 *     non-arbitrary place to put the line.
 *   - `minimumRespondents` is `MIN_SLO_SAMPLE_COUNT`, the smallest sample any
 *     contract in this repo will call a measurement. Reusing it rather than
 *     picking a new number keeps one answer to "how small is too small", and it
 *     is deliberately strict for a 25–40 person pilot: below it every question
 *     reads inconclusive, so a small study can neither raise a false alarm nor
 *     authorise a release.
 *   - `costQuestions` names the questions where a *higher* rating is a worse
 *     outcome. `intrusiveness` is in the study for exactly this reason — a
 *     product measuring only helpfulness learns to be louder — and reading it
 *     in the same direction as `helpfulness` would turn the cost question into
 *     a second benefit question.
 */
export const SHADOW_STUDY_EVIDENCE_POLICY = Object.freeze({
  neutralRating: (SHADOW_STUDY_RATING_SCALE.minimum + SHADOW_STUDY_RATING_SCALE.maximum) / 2,
  minimumRespondents: MIN_SLO_SAMPLE_COUNT,
  costQuestions: Object.freeze(['intrusiveness'] as const) as readonly ShadowStudyQuestionId[],
});

/**
 * The study, as quality evidence.
 *
 * One finding per question, in the question vocabulary's declaration order, so
 * a question nobody answered is visible as `insufficient_sample` rather than
 * missing from the package.
 */
export function qualityPillarFromStudy(
  summary: ShadowStudySummary,
  provenance: ShadowEvidenceProvenance,
): ShadowPillarSource {
  const findings: ShadowPillarFinding[] = summary.questions.map((entry) => {
    const base = { measureClass: 'user_judgement' as const, sloReading: null };
    if (entry.respondentCount < SHADOW_STUDY_EVIDENCE_POLICY.minimumRespondents) {
      return { ...base, disposition: 'inconclusive', citation: `study.insufficient_sample.${entry.question}` };
    }
    if (entry.meanRating === null) {
      return { ...base, disposition: 'inconclusive', citation: `study.no_ratings.${entry.question}` };
    }
    const isCost = SHADOW_STUDY_EVIDENCE_POLICY.costQuestions.includes(entry.question);
    if (entry.meanRating === SHADOW_STUDY_EVIDENCE_POLICY.neutralRating) {
      return { ...base, disposition: 'inconclusive', citation: `study.at_neutral.${entry.question}` };
    }
    // Equality was answered above, so this comparison only ever sees a mean
    // strictly on one side of the line. `>` and `>=` are the same function
    // here, which is why a mutation between them is equivalent rather than
    // uncaught — the boundary itself is pinned by the `at_neutral` branch.
    const above = entry.meanRating > SHADOW_STUDY_EVIDENCE_POLICY.neutralRating;
    const good = isCost ? !above : above;
    return {
      ...base,
      disposition: good ? 'benefit' : 'concern',
      citation: good ? `study.favourable.${entry.question}` : `study.unfavourable.${entry.question}`,
    };
  });
  return { provenance, findings, engagementContext: [] };
}

/** Two sources for one pillar, merged. Findings keep their listed order. */
export function mergePillarSources(
  first: ShadowPillarSource,
  second: ShadowPillarSource,
): ShadowPillarSource {
  // The weaker provenance wins: a pillar whose evidence is partly simulated
  // cannot authorise on the strength of the other half.
  const provenance: ShadowEvidenceProvenance =
    first.provenance === 'unavailable' || second.provenance === 'unavailable'
      ? (first.findings.length + second.findings.length === 0 ? 'unavailable' : 'simulated')
      : provenanceMayAuthorise(first.provenance) && provenanceMayAuthorise(second.provenance)
        ? 'real_exposure'
        : 'simulated';
  return {
    provenance,
    findings: [...first.findings, ...second.findings],
    engagementContext: [...first.engagementContext, ...second.engagementContext],
  };
}

/* ── Wiring: the safety seam (#45's traces) ──────────────────────── */

export interface ShadowSafetyObservations {
  readonly runCount: number;
  readonly blockedCount: number;
  readonly incidentCount: number;
}

/**
 * Safety evidence from observed shadow runs.
 *
 * An incident is a harm on its own and is not weighed against a run count:
 * "one incident in ten thousand runs" is still an incident, and the rate is a
 * sentence for the decision record. Below `MIN_SLO_SAMPLE_COUNT` runs the
 * absence of incidents is inconclusive rather than reassuring — not seeing a
 * thing in four runs is not evidence it does not happen.
 */
export function safetyPillarFromObservations(
  observations: ShadowSafetyObservations,
  provenance: ShadowEvidenceProvenance,
): ShadowPillarSource {
  const findings: ShadowPillarFinding[] = [];
  const base = { measureClass: 'safety_outcome' as const, sloReading: null };

  if (observations.incidentCount > 0) {
    findings.push({ ...base, disposition: 'harm', citation: 'safety.incident_recorded' });
  }
  if (observations.runCount === 0) {
    findings.push({ ...base, disposition: 'inconclusive', citation: 'safety.no_runs_observed' });
  } else if (observations.runCount < MIN_SLO_SAMPLE_COUNT) {
    findings.push({ ...base, disposition: 'inconclusive', citation: 'safety.insufficient_sample' });
  } else if (observations.incidentCount === 0) {
    findings.push({ ...base, disposition: 'benefit', citation: 'safety.no_incident_over_sample' });
  }
  return { provenance, findings, engagementContext: [] };
}

/* ── Wiring: the reliability seam (#46's SLO readings) ───────────── */

/**
 * Reliability evidence from SLO readings.
 *
 * The reading travels with the item rather than a number extracted from it, so
 * an item resting on an inconclusive reading cannot present itself as a
 * measured one — the contract's `EVIDENCE_SUPPORTS_GO_ON_INCONCLUSIVE_SLO`
 * exists for producers that try, and `supportFor` above makes it unreachable
 * from this generator.
 *
 * `citation` is the `sloId` itself: it is already a `SHADOW_SAFE_CODE` by
 * contract, and a prefix would risk pushing a long id past the pattern's
 * 64-character bound.
 */
export function reliabilityPillarFromSloReadings(
  readings: readonly ShadowSloReading[],
  provenance: ShadowEvidenceProvenance,
): ShadowPillarSource {
  return {
    provenance,
    findings: readings.map((reading) => ({
      measureClass: 'reliability_signal' as const,
      disposition:
        reading.status === 'inconclusive' ? 'inconclusive' : reading.breached ? 'harm' : 'benefit',
      citation: reading.sloId,
      sloReading: reading,
    })),
    engagementContext: [],
  };
}
