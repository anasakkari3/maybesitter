/**
 * The post validator: everything decidable only about a produced candidate.
 *
 * Reports; never throws, for any input — see `preValidator.ts` for why that
 * matters more here than anywhere else in the repo.
 *
 * **The evidence machinery is Sprint 08's.** `checkEvidenceGraph` answers "is
 * this graph structurally sound", `resolveEvidenceRoots` answers "what
 * observations does this claim actually rest on", and `isInstant` answers "is
 * this a real moment". None of the three is reimplemented here, and
 * `tests/safety/policyContract.test.ts` pins the function identities so a future
 * local copy fails rather than drifts. The one thing this module adds is the
 * *claim-level* question the recommendation module had no reason to ask: a claim
 * is not a `RecommendationReason`, so `checkRecommendation` cannot be pointed at
 * one, and the missing piece is a citation check plus an instant comparison —
 * not a second graph.
 *
 * **No clock, no randomness, no locale ordering.** Every finding is emitted in
 * input position order: segments, then claims, then effects, then the graph
 * passes, each inner loop in array order and each item in a fixed code order.
 */

import {
  CANDIDATE_CLAIM_KINDS,
  PROPOSED_EFFECT_KINDS,
  RECOMMENDATION_DECISION_VERDICTS,
  SAFETY_LIMITS,
  PRESSURE_INTENSITY_RANK,
  checkEvidenceGraph,
  instantsEqual,
  isInstant,
  millisBetweenInstants,
  resolveEvidenceRoots,
  sharesTextRunWith,
  type CandidateClaim,
  type CandidateSegment,
  type EvidenceGraph,
  type PressureIntensityLevel,
  type ProposedEffect,
  type RecommendationDecision,
  type SafetyCandidate,
  type SafetyFinding,
  type SafetyRequest,
  type UntrustedInput,
} from '../../src/contracts/v1/safetyContracts';
import {
  COERCION_PATTERNS,
  INJECTION_PATTERNS,
  INSTRUCTION_ECHO_RUN_LENGTH,
  MIN_IDENTIFIER_MATCH_LENGTH,
  PERSISTENCE_CLAIM_PATTERNS,
  SHAME_PATTERNS,
  matchesAny,
} from './lexicon';
import { asArray, capFindings, finding, isObject } from './findings';

/**
 * `CANDIDATE_CLAIM_KINDS` and `PROPOSED_EFFECT_KINDS` are imported from the
 * contract, not restated here.
 *
 * They *were* restated, in the first draft, and the adjudication that added
 * `decision_echo` is what surfaced it: adding a kind to the contract left this
 * file's private copy behind, so the new kind would have been reported
 * `UNKNOWN_CANDIDATE_SHAPE` by the very validator that is supposed to check it.
 * That is Sprint 06's lesson exactly — two copies of one datum do not check each
 * other, they wait for one of them to be edited — and it is worth recording that
 * the copies were four days old and had already diverged once.
 *
 * `SEGMENT_ROLES` stays local because the contract does not export it as data.
 * Named so the asymmetry is a decision rather than an oversight; the right fix
 * is to export it from the contract, and that belongs with the next change that
 * touches `CandidateSegment` rather than in a validator commit.
 */
const SEGMENT_ROLES = ['body', 'question', 'option_label', 'footnote'] as const;
const AUDIT_RUN_FOR_SENSITIVE_TEXT = 12;

export function validateSafetyCandidate(
  candidate: SafetyCandidate,
  request: SafetyRequest,
): readonly SafetyFinding[] {
  if (!isObject(candidate) || !Array.isArray((candidate as unknown as { segments?: unknown }).segments)) {
    return [
      finding(
        'UNKNOWN_CANDIDATE_SHAPE',
        'the candidate is not a readable candidate: it is absent, not an object, or carries no segment list',
      ),
    ];
  }

  const findings: SafetyFinding[] = [];
  const segments = asArray<CandidateSegment>(candidate.segments);
  const claims = asArray<CandidateClaim>(candidate.claims);
  const effects = asArray<ProposedEffect>(candidate.effects);
  const graph: EvidenceGraph = isObject(candidate.evidence) ? (candidate.evidence as EvidenceGraph) : { nodes: [] };
  const nodes = asArray<{ nodeId?: unknown }>(graph.nodes);

  const inputs = isObject(request) ? asArray<UntrustedInput>(request.inputs) : [];
  const sensitiveTexts = inputs
    .filter((input) => isObject(input) && input.sensitivity === 'sensitive' && typeof input.text === 'string')
    .map((input) => input.text);
  const injectedTexts = inputs
    .filter((input) => isObject(input) && typeof input.text === 'string' && matchesAny(input.text, INJECTION_PATTERNS))
    .map((input) => input.text);
  const identifiers = collectIdentifiers(candidate, claims, effects, nodes);
  const attested = isObject(request) ? asArray<RecommendationDecision>(request.attestedDecisions) : [];
  const nowInstant = isObject(request) ? request.now : undefined;

  /* ── Bounds first, and scanning stops at them ─────────────────── */

  findings.push(...limitFindings(segments, claims, effects, nodes));

  const scannedSegments = Math.min(segments.length, SAFETY_LIMITS.maxSegments);
  const scannedClaims = Math.min(claims.length, SAFETY_LIMITS.maxClaims);
  const scannedEffects = Math.min(effects.length, SAFETY_LIMITS.maxEffects);

  /* ── Segments: privacy, pressure, persistence, echo ───────────── */

  for (let index = 0; index < scannedSegments; index += 1) {
    const segment = segments[index];
    if (!isObject(segment) || typeof segment.text !== 'string' || !(SEGMENT_ROLES as readonly unknown[]).includes(segment.role)) {
      findings.push(
        finding('UNKNOWN_CANDIDATE_SHAPE', `segment #${index} is not a readable segment`, { segmentIndex: index }),
      );
      continue;
    }
    const text = segment.text;
    if (text.length > SAFETY_LIMITS.maxSegmentChars) {
      // Already reported by `limitFindings`; skipping the scans is what makes
      // the bound actually bound the work.
      continue;
    }

    const leakedIdentifier = identifiers.find((identifier) => text.includes(identifier));
    if (leakedIdentifier !== undefined) {
      findings.push(
        finding(
          'RAW_IDENTIFIER_DISCLOSED',
          `segment #${index} reproduces a caller-chosen identifier; identifiers are free strings people fill with content`,
          { segmentIndex: index },
        ),
      );
    }

    if (sharesTextRunWith(text, sensitiveTexts, AUDIT_RUN_FOR_SENSITIVE_TEXT)) {
      findings.push(
        finding(
          'SENSITIVE_TEXT_DISCLOSED',
          `segment #${index} reproduces a run of text from a span classified sensitive`,
          { segmentIndex: index },
        ),
      );
    }

    if (matchesAny(text, SHAME_PATTERNS)) {
      findings.push(
        finding('SHAMING_LANGUAGE', `segment #${index} labels the person rather than the situation`, {
          segmentIndex: index,
        }),
      );
    }

    if (matchesAny(text, COERCION_PATTERNS)) {
      findings.push(
        finding('COERCIVE_PRESSURE', `segment #${index} removes the person's option to decline`, {
          segmentIndex: index,
        }),
      );
    }

    if (matchesAny(text, PERSISTENCE_CLAIM_PATTERNS)) {
      // Deliberately stricter than the product's `stateChange === 'none'` rule.
      // The gateway guards modules that propose; a proposal may never speak in
      // the perfect tense, whatever it declared about its own state changes.
      findings.push(
        finding('PERSISTENCE_CLAIMED', `segment #${index} states that a write already happened`, {
          segmentIndex: index,
        }),
      );
    }

    if (sharesTextRunWith(text, injectedTexts, INSTRUCTION_ECHO_RUN_LENGTH)) {
      findings.push(
        finding('INSTRUCTION_ECHOED', `segment #${index} reproduces text from a span flagged as an injection`, {
          segmentIndex: index,
        }),
      );
    }
  }

  /**
   * An injected instruction reproduced into an *identifier* rather than into
   * prose.
   *
   * This is not a hypothetical shape: Sprint 07's recorded leak was
   * `call-dr.cohen-about-the-biopsy`, an id a producer had filled with content.
   * It matters here because such a finding names **no segment**, so redaction
   * has nothing to drop — which is exactly the case the gateway escalates to a
   * block rather than resolving "redact it" into "show it".
   */
  for (let index = 0; index < scannedClaims; index += 1) {
    const claim = claims[index];
    const claimId = isObject(claim) && typeof claim.claimId === 'string' ? claim.claimId : '';
    if (claimId.length > 0 && sharesTextRunWith(claimId, injectedTexts, INSTRUCTION_ECHO_RUN_LENGTH)) {
      findings.push(
        finding(
          'INSTRUCTION_ECHOED',
          `the identifier of claim #${index} reproduces text from a span flagged as an injection, and no segment carries it`,
          { claimIndex: index },
        ),
      );
    }
  }

  /* ── Claims: provenance and time ──────────────────────────────── */

  const graphDefects = checkEvidenceGraph(graph);
  const graphIsSound = graphDefects.length === 0;
  const nodesWithinBound = nodes.length <= SAFETY_LIMITS.maxEvidenceNodes;
  if (!graphIsSound) {
    findings.push(
      finding(
        'EVIDENCE_GRAPH_MALFORMED',
        `the evidence graph carries ${graphDefects.length} structural defects, so nothing in it can be traced`,
      ),
    );
  }

  for (let index = 0; index < scannedClaims; index += 1) {
    const claim = claims[index];
    if (!isObject(claim) || !(CANDIDATE_CLAIM_KINDS as readonly unknown[]).includes(claim.kind)) {
      findings.push(
        finding('UNKNOWN_CANDIDATE_SHAPE', `claim #${index} states a kind this version does not recognise`, {
          claimIndex: index,
        }),
      );
      continue;
    }

    /**
     * A decision echo rests on an attested act rather than on the evidence
     * graph, so it takes the decision checks in place of `UNSOURCED_CLAIM` —
     * never *instead of a check*. See `CandidateClaimKind` in the contract for
     * the cross-track ruling this implements.
     *
     * The exemption is deliberately narrow, and `validators.test.ts` pins that:
     * a claim of any other kind with an empty `supportedBy` still reports
     * `UNSOURCED_CLAIM`, and a `decision_echo` that names nothing still reports
     * `DECISION_ECHO_UNATTESTED`. Sprint 08 recorded what an exemption becomes
     * when nothing stops it widening — the place whatever stopped working gets
     * put.
     */
    if (claim.kind === 'decision_echo') {
      findings.push(...decisionEchoFindings(claim, index, attested, nowInstant));
      continue;
    }

    const cited = asArray<string>(claim.supportedBy);
    if (cited.length === 0) {
      // The claim rests on nothing, and that is decidable without the graph, so
      // it is not suppressed by anything below.
      findings.push(
        finding('UNSOURCED_CLAIM', `claim #${index} cites no evidence at all`, { claimIndex: index }),
      );
      continue;
    }

    const scannedRefs = Math.min(cited.length, SAFETY_LIMITS.maxEvidenceRefsPerClaim);

    // Everything from here borrows its bound from the graph, so it is suppressed
    // when the graph is already reported malformed or was too large to walk.
    // `planningContracts`' suppression rule: a finding is suppressed only when it
    // borrows from something already reported.
    if (!graphIsSound || !nodesWithinBound) continue;

    const roots = [];
    let traceable = true;
    for (let refIndex = 0; refIndex < scannedRefs; refIndex += 1) {
      const resolved = resolveEvidenceRoots(graph, cited[refIndex]);
      if (resolved === null) {
        traceable = false;
        findings.push(
          finding(
            'CLAIM_NOT_TRACEABLE',
            `citation #${refIndex} of claim #${index} reaches no observation of trusted state`,
            { claimIndex: index },
          ),
        );
        continue;
      }
      roots.push(...resolved);
    }

    if (claim.kind !== 'time') continue;
    if (claim.statedInstant === null || claim.statedInstant === undefined) continue;

    if (!isInstant(claim.statedInstant)) {
      // `2026-02-30T00:00:00Z` matches every shape check and `Date.parse` reads
      // it as the 2nd of March. A malformed instant borrows nothing to compare,
      // so the fabrication check below is suppressed: one defect earns one code.
      findings.push(
        finding(
          'INSTANT_MALFORMED',
          `claim #${index} states a time that is not a real moment carrying an explicit offset`,
          { claimIndex: index },
        ),
      );
      continue;
    }

    if (!traceable) continue;

    const carried = roots.some(
      (root) => isObject(root) && isObject(root.claim) && root.claim.kind === 'instant' && instantsEqual(root.claim.value, claim.statedInstant),
    );
    if (!carried) {
      findings.push(
        finding(
          'FABRICATED_INSTANT',
          `claim #${index} states a time that no observation it rests on actually carries`,
          { claimIndex: index },
        ),
      );
    }
  }

  /* ── Effects: the persistence boundary ────────────────────────── */

  for (let index = 0; index < scannedEffects; index += 1) {
    const effect = effects[index];
    if (!isObject(effect) || !(PROPOSED_EFFECT_KINDS as readonly unknown[]).includes(effect.kind)) {
      findings.push(
        finding('UNKNOWN_CANDIDATE_SHAPE', `effect #${index} states a kind this version does not recognise`, {
          effectIndex: index,
        }),
      );
      continue;
    }
    if (effect.kind === 'canonical_write') {
      findings.push(
        finding(
          'UNCONFIRMED_WRITE_PROPOSED',
          `effect #${index} writes canonical state directly, which STATE_WRITE_POLICY forbids for every intelligence module`,
          { effectIndex: index },
        ),
      );
      continue;
    }
    if (effect.kind === 'propose_write' && effect.requiresConfirmation !== true) {
      findings.push(
        finding('UNCONFIRMED_WRITE_PROPOSED', `effect #${index} proposes a write that no one has to confirm`, {
          effectIndex: index,
        }),
      );
    }
  }

  /* ── Pressure intensity ───────────────────────────────────────── */

  const budget = isObject(request) && isObject(request.pressureBudget) ? request.pressureBudget : null;
  if (budget !== null) {
    const declared = rankOfDeclaredPressure(candidate.pressure);
    const permitted = rankOfPermittedPressure(budget.maxIntensity);
    if (declared > permitted) {
      findings.push(
        finding(
          'PRESSURE_INTENSITY_EXCEEDED',
          'the candidate declares more pressure than this surface is budgeted for',
        ),
      );
    }
  }

  return capFindings(findings, 'CANDIDATE_EXCEEDS_LIMIT');
}

/**
 * Judge one `decision_echo` claim against the acts the request attests to.
 *
 * Indexes into `attested`; never iterates it. That is why `attestedDecisions`
 * carries no bound in `SAFETY_LIMITS` — a bound that constrains no work is the
 * decorative kind Sprint 08 paid for.
 *
 * Reports at most one finding per claim: one defect earns one code, and an
 * unattested echo has no verdict to disagree with.
 */
function decisionEchoFindings(
  claim: CandidateClaim,
  index: number,
  attested: readonly RecommendationDecision[],
  now: unknown,
): readonly SafetyFinding[] {
  const position = claim.decisionIndex;
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position >= attested.length) {
    return [
      finding(
        'DECISION_ECHO_UNATTESTED',
        `claim #${index} states that the person took an action, and the request attests to no such act at that position`,
        { claimIndex: index },
      ),
    ];
  }

  const decision = attested[position];
  if (!isObject(decision)) {
    return [
      finding('DECISION_ECHO_UNATTESTED', `claim #${index} names an attestation that is not readable`, {
        claimIndex: index,
      }),
    ];
  }

  /**
   * An act recorded as happening after the evaluation instant has not happened.
   *
   * Folded into `UNATTESTED` rather than given its own code, on the reading
   * stated in the contract: such a record attests to nothing *at this instant*.
   * Suppressed — not decided — when either instant is unusable, because the
   * comparison would borrow its bound from a field already reported malformed by
   * `EVALUATION_INSTANT_INVALID`. Deciding it anyway is the direction that makes
   * a check pass hardest exactly when the caller has lost the clock.
   */
  const elapsed = millisBetweenInstants(decision.decidedAt, now);
  if (elapsed !== null && elapsed < 0) {
    return [
      finding(
        'DECISION_ECHO_UNATTESTED',
        `claim #${index} states that the person took an action recorded as happening after the moment being judged`,
        { claimIndex: index },
      ),
    ];
  }

  const echoed = claim.echoedVerdict;
  if (!(RECOMMENDATION_DECISION_VERDICTS as readonly unknown[]).includes(echoed)) {
    return [
      finding(
        'DECISION_ECHO_UNATTESTED',
        `claim #${index} attributes an act to the person that this contract version does not recognise`,
        { claimIndex: index },
      ),
    ];
  }

  if (echoed !== decision.verdict) {
    return [
      finding(
        'DECISION_ECHO_MISMATCHED',
        `claim #${index} attributes a different act to the person than the one the attested record carries`,
        { claimIndex: index },
      ),
    ];
  }

  return [];
}

function limitFindings(
  segments: readonly CandidateSegment[],
  claims: readonly CandidateClaim[],
  effects: readonly ProposedEffect[],
  nodes: readonly unknown[],
): readonly SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  if (segments.length > SAFETY_LIMITS.maxSegments) {
    findings.push(
      finding(
        'CANDIDATE_EXCEEDS_LIMIT',
        `the candidate carries ${segments.length} segments; the bound is ${SAFETY_LIMITS.maxSegments}`,
        { limitName: 'maxSegments' },
      ),
    );
  }
  for (let index = 0; index < Math.min(segments.length, SAFETY_LIMITS.maxSegments); index += 1) {
    const segment = segments[index];
    const text = isObject(segment) && typeof segment.text === 'string' ? segment.text : '';
    if (text.length > SAFETY_LIMITS.maxSegmentChars) {
      findings.push(
        finding(
          'CANDIDATE_EXCEEDS_LIMIT',
          `segment #${index} carries ${text.length} characters; the bound is ${SAFETY_LIMITS.maxSegmentChars}`,
          { segmentIndex: index, limitName: 'maxSegmentChars' },
        ),
      );
    }
  }
  if (claims.length > SAFETY_LIMITS.maxClaims) {
    findings.push(
      finding(
        'CANDIDATE_EXCEEDS_LIMIT',
        `the candidate carries ${claims.length} claims; the bound is ${SAFETY_LIMITS.maxClaims}`,
        { limitName: 'maxClaims' },
      ),
    );
  }
  for (let index = 0; index < Math.min(claims.length, SAFETY_LIMITS.maxClaims); index += 1) {
    const claim = claims[index];
    const cited = isObject(claim) ? asArray<string>(claim.supportedBy) : [];
    if (cited.length > SAFETY_LIMITS.maxEvidenceRefsPerClaim) {
      findings.push(
        finding(
          'CANDIDATE_EXCEEDS_LIMIT',
          `claim #${index} cites ${cited.length} evidence nodes; the bound is ${SAFETY_LIMITS.maxEvidenceRefsPerClaim}`,
          { claimIndex: index, limitName: 'maxEvidenceRefsPerClaim' },
        ),
      );
    }
  }
  if (nodes.length > SAFETY_LIMITS.maxEvidenceNodes) {
    findings.push(
      finding(
        'CANDIDATE_EXCEEDS_LIMIT',
        `the evidence graph carries ${nodes.length} nodes; the bound is ${SAFETY_LIMITS.maxEvidenceNodes}`,
        { limitName: 'maxEvidenceNodes' },
      ),
    );
  }
  if (effects.length > SAFETY_LIMITS.maxEffects) {
    findings.push(
      finding(
        'CANDIDATE_EXCEEDS_LIMIT',
        `the candidate carries ${effects.length} effects; the bound is ${SAFETY_LIMITS.maxEffects}`,
        { limitName: 'maxEffects' },
      ),
    );
  }
  return findings;
}

/**
 * Every caller-chosen identifier attached to this candidate, long enough to be
 * worth searching prose for.
 *
 * Deduplicated and bounded by the same limits everything else is, so a candidate
 * cannot make this scan quadratic by carrying half a million node ids.
 */
function collectIdentifiers(
  candidate: SafetyCandidate,
  claims: readonly CandidateClaim[],
  effects: readonly ProposedEffect[],
  nodes: readonly { nodeId?: unknown }[],
): readonly string[] {
  const found = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    if (value.trim().length < MIN_IDENTIFIER_MATCH_LENGTH) return;
    found.add(value);
  };
  add(candidate.candidateId);
  for (let index = 0; index < Math.min(claims.length, SAFETY_LIMITS.maxClaims); index += 1) {
    const claim = claims[index];
    if (isObject(claim)) add(claim.claimId);
  }
  for (let index = 0; index < Math.min(effects.length, SAFETY_LIMITS.maxEffects); index += 1) {
    const effect = effects[index];
    if (isObject(effect)) add(effect.effectId);
  }
  for (let index = 0; index < Math.min(nodes.length, SAFETY_LIMITS.maxEvidenceNodes); index += 1) {
    const node = nodes[index];
    if (isObject(node)) add(node.nodeId);
  }
  return Array.from(found);
}

/**
 * The declared and permitted sides rank an unknown level in opposite directions,
 * for the reason `rankOfDeclared`/`rankOfPermitted` do in `preValidator.ts`, and
 * this file made the same mistake first: one shared helper returning
 * `MAX_SAFE_INTEGER` reads an unreadable *budget* as permitting the hardest push
 * available. The red-team case that caught it was a request whose
 * `pressureBudget` carried no `maxIntensity` at all — which is what a caller
 * that half-built a budget object actually sends.
 */
function rankOfDeclaredPressure(value: unknown): number {
  const rank = PRESSURE_INTENSITY_RANK[value as PressureIntensityLevel];
  return typeof rank === 'number' ? rank : Number.MAX_SAFE_INTEGER;
}

function rankOfPermittedPressure(value: unknown): number {
  const rank = PRESSURE_INTENSITY_RANK[value as PressureIntensityLevel];
  return typeof rank === 'number' ? rank : PRESSURE_INTENSITY_RANK.none;
}
