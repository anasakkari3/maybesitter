/**
 * The three Sprint 09 tracks, joined and run against each other.
 *
 * #37 (rubric, adversarial corpus, scorer), #38 (planner, realizer, validator,
 * delivery) and #39 (the safety gateway) were built in parallel against
 * contracts written first, so each was verified only against its own reading of
 * them. Every track's own suite is green; that is exactly the state the roadmap
 * says proves nothing. Sprint 02 recorded "91 tests passed while they
 * disagreed"; Sprint 06 recorded three copies of one lexicon that disagreed on
 * 20 of 31 probed titles; Sprint 08's cross-track file compared **deduplicated
 * code names** and reported two readers in perfect agreement while they
 * disagreed about 38% of inputs.
 *
 * So this file does not ask "does each track work". It asks the four questions
 * no single track is in a position to ask, plus two that guard the answers:
 *
 *  1. **The join.** #37 *declares* what a row should provoke, #38 *produces*
 *     the candidate, #39 *judges* it. Each of those three is a different
 *     module's opinion about one input, and until they are run in one process
 *     against one row, "the corpus provokes `UNSOURCED_CLAIM`" is a comment.
 *     Comparison is at `(claimIndex, segmentIndex, code)` locator pairs, never
 *     at bare code names — see `pairsOf`.
 *
 *  2. **The decision-echo path, end to end.** The sharpest safety property this
 *     sprint has: #38's own contract calls a fabricated completion the worst
 *     output its module can produce and "one field away from a correct one".
 *     #39 added `DECISION_ECHO_UNATTESTED` and `DECISION_ECHO_MISMATCHED` for
 *     it, and #38's conversion matches attestations on `(recommendationId,
 *     optionIndex)` and deliberately **not** on the verdict. The value of that
 *     last decision is invisible inside either track: it only shows up when a
 *     fabricated `done` is offered a real `done` record belonging to a
 *     different option and has to fail to launder itself through it.
 *
 *  3. **The multilingual gap, as a number.** #39's shame and coercion lexicons
 *     are English regular expressions and #39's own header says so. #37's
 *     Arabic and Hebrew rows exist to measure that, and a gap that is only
 *     described in prose is a gap nobody re-measures. Group 3 asserts the
 *     current detection counts per locale — it deliberately does **not** assert
 *     the gap is closed, because pretending it is would be worse than the gap.
 *     A number in a test changes visibly when the code changes; a sentence in a
 *     doc goes quietly false.
 *
 *  4. **The documented disagreements, asserted as disagreements.** Two places
 *     where the tracks are *supposed* to differ, and where a future change that
 *     made them agree would look like an improvement and be a regression:
 *     `FABRICATED_INSTANT` (provenance) against the shipped engine's ISO-date
 *     ban (presentation), and `echo_kind_not_licensed`, which #38's
 *     `checkCoachingPlan` does not catch and #37's `checkCoachingFaithfulness`
 *     does.
 *
 *  5. **The anti-drift identity.** `PERSISTENCE_LEXICON.en` is
 *     `COACHING_FORBIDDEN_LANGUAGE.trackingVerbs` **by object identity**, not by
 *     value. Asserted with `assert.equal`, because a copy that has not drifted
 *     yet passes `deepEqual` and then drifts on the next edit — which is the
 *     Sprint 06 failure precisely.
 *
 *  6. **The suite guards itself.** `node --test` silently skips a registered
 *     file that does not exist and exits 0 — measured on this runner, not
 *     assumed. A typo in `package.json` would delete a whole track's coverage
 *     with no signal, and every guard above sits behind that failure mode. The
 *     reverse direction matters just as much: a file present on disk and
 *     registered nowhere runs never, reports nothing, and looks exactly like a
 *     file that passes.
 *
 * No `Math.random`, no ambient clock, no `localeCompare`. Every instant is a
 * literal, every corpus is the seeded `defaultCorpus()`, and every sort is by
 * code point.
 *
 * This file is owned by the merge, on the terms Sprint 05 gave the policy-freeze
 * test to the merge: a check owned by the thing it checks is not a check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* #37 — the rubric, the corpus and the lexicons that judge them. */
import {
  PERSISTENCE_LEXICON,
  checkCoachingFaithfulness,
  checkCoachingLanguage as rubricLanguagePass,
  evaluateRubric,
} from '../../lib/coaching/evaluation/rubric.ts';
import {
  buildRow,
  defaultCorpus,
  provokedSafetyCodes,
  type CoachingEvaluationRow,
} from '../../lib/coaching/evaluation/evaluationSet.ts';

/* #38 — the producer, its conversion to the safety seam, its own language gate. */
import { identifiersOf, toSafetyCandidate } from '../../lib/coaching/deliver.ts';
import { checkCoachingLanguage as coachingLanguagePass } from '../../lib/coaching/validator/language.ts';
import {
  COACHING_FORBIDDEN_LANGUAGE,
  COACHING_LOCALES,
  ENGINE_LEXICON_PARITY,
  checkCoachingPlan,
  type CoachingLocale,
} from '../../src/contracts/v1/coachingContracts.ts';

/* #39 — the gateway, run for real. Never a stub. */
import { evaluateSafetyGate } from '../../lib/safety/index.ts';
import {
  SAFETY_CODE_PARTITIONS,
  type Instant,
  type SafetyCandidate,
  type SafetyReasonCode,
  type SafetyRequest,
  type SafetyVerdict,
} from '../../src/contracts/v1/safetyContracts.ts';
import {
  RECOMMENDATION_CONTRACT_VERSION,
  type EvidenceGraph,
  type RecommendationDecision,
  type RecommendationDecisionVerdict,
} from '../../src/contracts/v1/recommendationContracts.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');

/**
 * The evaluation instant, and the instant every attested act is recorded at.
 *
 * Literals, because `lib/safety/**` and `lib/coaching/**` both refuse to read a
 * clock and a test that supplied one would be the only source of nondeterminism
 * in the join. `NOW` is after the corpus's own `BASIS_AT` (09:30) so that no row
 * is incidentally judged against a moment before it was built, and `DECIDED_AT`
 * is before `NOW` so that an honest echo is not reported
 * `DECISION_ECHO_UNATTESTED` for the "recorded as happening after now" reason —
 * which would make every echo row pass for the wrong cause.
 */
const NOW = '2026-08-19T10:30:00.000Z' as Instant;
const DECIDED_AT = '2026-08-19T09:20:00.000Z' as Instant;

/**
 * What the request attests, derived from what the **plan** says the person did.
 *
 * This is the one modelling decision in the file and it is load-bearing, so it
 * is stated rather than buried. `SafetyRequest.attestedDecisions` is the
 * caller's record of acts that actually happened; `CoachingPlan.acknowledges` is
 * what the plan believes it is acknowledging. Deriving the attestation from the
 * plan is the honest reading of "the request attests what the person did":
 *
 *   - `fabricated_decision_echo` sets `acknowledges: null` while the output goes
 *     on echoing a decision, so this attests **nothing** — and the echo has to
 *     find no record, which is what `DECISION_ECHO_UNATTESTED` means.
 *   - `mismatched_decision_verdict` leaves `acknowledges` alone and rewrites the
 *     echoed verdict, so this attests the real act and the echo has to be caught
 *     disagreeing with it.
 *
 * Deriving it from the *output* instead would attest whatever the output
 * claimed, which is a fixture measuring itself: every fabrication would come
 * with its own alibi and both codes would be unreachable.
 */
function attestationsFor(row: CoachingEvaluationRow): readonly RecommendationDecision[] {
  const acknowledges = row.input.plan.acknowledges;
  if (acknowledges === null || acknowledges === undefined) return [];
  return [
    {
      version: RECOMMENDATION_CONTRACT_VERSION,
      recommendationId: row.input.plan.recommendationId,
      optionIndex: 0,
      verdict: acknowledges,
      decidedAt: DECIDED_AT,
    },
  ];
}

/**
 * A well-formed request whose only interesting field is what it attests.
 *
 * Everything else is deliberately unremarkable: no untrusted input spans, a
 * budget that permits `medium` pressure and has never been used. That is not
 * laziness — every pre-stage code is named in #37's `EXCLUDED_SAFETY_CODES` as
 * structurally unreachable from a coaching candidate, so a request engineered to
 * trip one would be testing #39 against itself rather than testing the join.
 */
function requestWith(attested: readonly RecommendationDecision[]): SafetyRequest {
  return {
    requestId: 'req-coaching-cross-track',
    surface: 'coaching_message',
    now: NOW,
    inputs: [],
    permittedSensitivity: 'personal',
    pressureBudget: {
      maxIntensity: 'medium',
      minIntervalMinutes: 60,
      lastPressuredAt: null,
      consecutiveUnansweredCount: 0,
      maxConsecutiveUnanswered: 3,
    },
    attestedDecisions: attested,
  };
}

/** One row, all the way through: #37 declares it, #38 converts it, #39 judges it. */
function judge(row: CoachingEvaluationRow): SafetyVerdict {
  const attested = attestationsFor(row);
  const candidate = toSafetyCandidate(row.input.output, `candidate-${row.rowId}`, attested);
  return evaluateSafetyGate({
    request: requestWith(attested),
    candidate,
    auditId: `audit-${row.rowId}`,
  }).verdict;
}

/**
 * Findings as **locator pairs**, sorted by code point and deduplicated.
 *
 * Pairs rather than bare code names, and the distinction is the whole strength
 * of this file. Sprint 08's cross-track test compared
 * `Set(findings.map((f) => f.code))` and reported perfect agreement between two
 * readers that disagreed about 38% of its inputs: a code contributed by the
 * *right* claim covered for the same code missing from the *wrong* one, and the
 * set saw one name either way.
 *
 * `claimIndex` is the locator the comparison is named for. `segmentIndex` is
 * carried beside it because roughly half of the codes a coaching candidate can
 * reach are segment-scoped and carry `claimIndex: null` — pairing on
 * `claimIndex` alone would collapse every one of them onto the same key and
 * reinstate exactly the defect the pairing exists to prevent.
 *
 * Multiplicity is collapsed. The contract leaves it to the validator whether one
 * condition yields one finding or several; *who* a finding is about is not left
 * open, and that is what this compares.
 */
function pairsOf(verdict: SafetyVerdict): string[] {
  return Array.from(
    new Set(
      verdict.findings.map(
        (finding) => `${finding.code}@claim:${finding.claimIndex}/segment:${finding.segmentIndex}`,
      ),
    ),
  ).sort(byCodePoint);
}

/** Ordering by code point. `localeCompare` is host-locale dependent and banned repo-wide. */
function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/* ── 1. #37's corpus, through #38's producer and #39's gateway ───── */

/**
 * Where the gateway puts a finding for each code the corpus can provoke.
 *
 * Measured against the merged code, then pinned — the point of the table is
 * that a locator moving is a change to what the verdict is *about*, and that is
 * a thing a reviewer should be told rather than something a set comparison
 * absorbs. Every corpus row mutates claim 0 and rewrites sentence 0, so a
 * finding landing anywhere else means either the corpus builder or the
 * validator started pointing somewhere new.
 *
 * `EVIDENCE_GRAPH_MALFORMED` names nothing on purpose: the graph is malformed as
 * a whole and no single claim owns that, which is why #39 files one code for
 * Sprint 08's entire graph defect list rather than translating eight of them.
 */
const GATEWAY_LOCATOR: Readonly<Record<string, string>> = Object.freeze({
  UNSOURCED_CLAIM: 'claim:0/segment:null',
  CLAIM_NOT_TRACEABLE: 'claim:0/segment:null',
  EVIDENCE_GRAPH_MALFORMED: 'claim:null/segment:null',
  DECISION_ECHO_UNATTESTED: 'claim:0/segment:null',
  DECISION_ECHO_MISMATCHED: 'claim:0/segment:null',
  SHAMING_LANGUAGE: 'claim:null/segment:0',
  COERCIVE_PRESSURE: 'claim:null/segment:0',
});

/**
 * How far each code #37 declares actually travels across the seam.
 *
 * #37's `provokes` is an **expectation recorded by a track that does not import
 * `lib/safety/**`**, and it says so. Running it for real splits it three ways,
 * and the split is the finding this group exists to produce. Naming the three
 * kinds — rather than filtering the failures out — is what keeps a
 * currently-unreachable code from quietly becoming a permanently unreachable
 * one:
 *
 *  - `decided_by_the_gateway` — #39 reports it, for every row that declares it,
 *    in every locale. Five of the ten, and every one of them structural.
 *
 *  - `english_lexicon_only` — #39 reports it for `en` and for nothing else,
 *    because `SHAME_PATTERNS` and `COERCION_PATTERNS` in `lib/safety/lexicon.ts`
 *    are English regular expressions. Group 3 turns this into counts.
 *
 *  - `not_carried_across_the_seam` — #39 reports it for **no** row, in **no**
 *    locale, and the reason is structural rather than linguistic in all three
 *    cases. These are the genuine cross-track gaps, and each one is asserted
 *    together with the checker that does catch it, so "#39 is silent here" can
 *    never quietly become "nothing sees this".
 */
type Reachability =
  | { readonly kind: 'decided_by_the_gateway' }
  | { readonly kind: 'english_lexicon_only' }
  | { readonly kind: 'not_carried_across_the_seam'; readonly why: string };

const CODE_REACHABILITY: Readonly<Record<string, Reachability>> = Object.freeze({
  UNSOURCED_CLAIM: { kind: 'decided_by_the_gateway' },
  CLAIM_NOT_TRACEABLE: { kind: 'decided_by_the_gateway' },
  EVIDENCE_GRAPH_MALFORMED: { kind: 'decided_by_the_gateway' },
  DECISION_ECHO_UNATTESTED: { kind: 'decided_by_the_gateway' },
  DECISION_ECHO_MISMATCHED: { kind: 'decided_by_the_gateway' },
  SHAMING_LANGUAGE: { kind: 'english_lexicon_only' },
  COERCIVE_PRESSURE: { kind: 'english_lexicon_only' },
  PERSISTENCE_CLAIMED: {
    kind: 'not_carried_across_the_seam',
    why:
      "#39's PERSISTENCE_CLAIM_PATTERNS are anchored on a completed assertion — a sentence-initial past " +
      'participle, a first-person past-tense verb, or an explicit "has been" — because its header rules that ' +
      'an offer is not a claim. #37\'s surveillance rows promise future or ongoing watching ("I am keeping ' +
      'track of that one for you"), which is a false claim of persistence and is not a claim that a write ' +
      'already happened. The two rules are about different tenses of the same lie.',
  },
  RAW_IDENTIFIER_DISCLOSED: {
    kind: 'not_carried_across_the_seam',
    why:
      "#39's collectIdentifiers reads only identifiers the *candidate* carries — candidateId, claimId, " +
      "effectId, nodeId. #37 plants a commitment id, which lives on the recommendation, and #38's " +
      'toSafetyCandidate carries no recommendation identifier across the seam. identifiersOf() sits in the ' +
      "same file and feeds #38's own language gate, so the leak is caught — one seam earlier than #37 expected.",
  },
  UNKNOWN_CANDIDATE_SHAPE: {
    kind: 'not_carried_across_the_seam',
    why:
      'the defect is a *sentence* citing a claim position the output does not have. toSafetyCandidate maps ' +
      'sentence text to segments and drops claimIndices, so the candidate #39 receives is perfectly ' +
      "well-formed. #37's own note says it: neither gate applies to a turn that is not one.",
  },
});

test('every #39 code the corpus declares is classified, and the classification is exhaustive', () => {
  // First, because everything below reads this table. A code added to
  // `ADVERSARIAL_CATEGORY_SPECS.provokes` without a decision here would be
  // silently skipped by `expectedPairs` — the filter would read the missing
  // entry as "not reachable" and the new expectation would never be checked.
  const declared = Array.from(provokedSafetyCodes()).sort(byCodePoint);
  const classified = Object.keys(CODE_REACHABILITY).sort(byCodePoint);
  assert.deepEqual(
    declared,
    classified,
    'the corpus declares a #39 code this file has not classified, or classifies one the corpus no longer declares',
  );

  // Every one of them is a post-stage code, which is the structural reason the
  // pre stage is out of scope here: a pre code is decided about a request before
  // any candidate exists, so no producer could provoke one.
  const post = new Set<string>(SAFETY_CODE_PARTITIONS.post);
  for (const code of declared) {
    assert.ok(post.has(code), `${code} is declared by the corpus and is not a post-stage code`);
  }
});

/** The pairs the join should produce for one row, derived rather than listed. */
function expectedPairs(row: CoachingEvaluationRow): string[] {
  const pairs: string[] = [];
  for (const code of row.expectation.provokes as readonly string[]) {
    const reach = CODE_REACHABILITY[code];
    if (reach === undefined || reach.kind === 'not_carried_across_the_seam') continue;
    if (reach.kind === 'english_lexicon_only' && row.locale !== 'en') continue;
    pairs.push(`${code}@${GATEWAY_LOCATOR[code]}`);
  }
  return Array.from(new Set(pairs)).sort(byCodePoint);
}

test("#37's declared gate is the gate #37's rubric actually reaches, for every row", () => {
  // The corpus's own half of the join, and the one that would fail first if the
  // rubric stopped detecting a category: `expectation.expectedGate` is what the
  // row is *for*, and a row whose measured gate drifts is a row that has quietly
  // stopped attacking what it claims to attack.
  const rows = defaultCorpus();
  assert.ok(rows.length >= 180, `the default corpus shrank to ${rows.length} rows`);

  const disagreements: string[] = [];
  for (const row of rows) {
    const measured = evaluateRubric(row.input).gate;
    if (measured !== row.expectation.expectedGate) {
      disagreements.push(
        `${row.category}/${row.locale}/${row.scenario}: declared ${row.expectation.expectedGate}, measured ${measured}`,
      );
    }
  }
  assert.deepEqual(disagreements, [], `rows whose declared gate is not the one the rubric reaches:\n  ${disagreements.join('\n  ')}`);
});

test("#37's declared codes are the codes #39 reports on #38's candidate, at the same locators", () => {
  // The join no track can test. #37 declares, #38 produces, #39 judges, and
  // until all three run on one row in one process the corpus's `provokes` list
  // is a comment about a module it does not import.
  //
  // Equality, not containment, in both directions: a missing code is a defect
  // #39 stopped catching, and an *extra* code is #39 refusing a row for a reason
  // #37 never modelled — which would make the corpus's category counts describe
  // something other than what they say.
  const rows = defaultCorpus();
  const disagreements: string[] = [];

  for (const row of rows) {
    const verdict = judge(row);
    const observed = pairsOf(verdict);
    const expected = expectedPairs(row);
    if (observed.join('|') !== expected.join('|')) {
      disagreements.push(
        `${row.rowId} [${row.category}/${row.locale}/${row.scenario}]\n` +
          `      #37 declares: ${JSON.stringify(row.expectation.provokes)}\n` +
          `      expected pairs: ${JSON.stringify(expected)}\n` +
          `      #39 reported:   ${JSON.stringify(observed)}`,
      );
      continue;
    }

    // The disposition follows from the codes, and is checked so that a severity
    // table edit cannot turn a block into an allow while the codes stay the same.
    // Every code reachable here is `blocking`, so there is no middle state: a
    // row that provokes nothing must be allowed outright, and a row that
    // provokes anything must be refused outright.
    assert.equal(
      verdict.disposition,
      expected.length === 0 ? 'allow' : 'block',
      `${row.rowId}: ${expected.length} expected findings and a disposition of ${verdict.disposition}`,
    );

    // Multiplicity is collapsed by `pairsOf`, so this is what stops the collapse
    // from hiding a second finding at a locator the first already occupied.
    assert.equal(
      verdict.findings.length,
      expected.length,
      `${row.rowId}: ${verdict.findings.length} findings collapsed to ${expected.length} locator pairs`,
    );
  }

  assert.deepEqual(
    disagreements,
    [],
    `#37, #38 and #39 disagree about these rows:\n    ${disagreements.join('\n    ')}`,
  );
});

test('the three codes that do not cross the seam are caught one seam earlier, not lost', () => {
  // `not_carried_across_the_seam` is only defensible while something else
  // catches the row. If nothing did, the classification above would be a way of
  // spelling "we decided not to look".
  const rows = defaultCorpus();
  const byCategory = (category: string): readonly CoachingEvaluationRow[] =>
    rows.filter((row) => row.category === category);

  // RAW_IDENTIFIER_DISCLOSED — caught by #38's own language gate, which is fed
  // `identifiersOf(recommendation)`: the identifiers #39 never receives.
  const identifierRows = byCategory('identifier_in_prose');
  assert.ok(identifierRows.length >= 3, 'the corpus no longer carries identifier_in_prose rows');
  for (const row of identifierRows) {
    assert.deepEqual(
      pairsOf(judge(row)),
      [],
      `${row.rowId}: #39 now sees the planted identifier; the seam changed and CODE_REACHABILITY is stale`,
    );
    const codes = coachingLanguagePass(row.input.output, identifiersOf(row.input.recommendation)).map((d) => d.code);
    assert.ok(
      codes.includes('IDENTIFIER_IN_PROSE'),
      `${row.rowId}: #39 cannot see the identifier and #38 no longer catches it either — the leak is now uncaught`,
    );
  }

  // UNKNOWN_CANDIDATE_SHAPE — caught by #37's rubric as `inadmissible`, before
  // either gate is consulted, which is what the category's own note claims.
  const inadmissible = byCategory('structurally_inadmissible');
  assert.ok(inadmissible.length >= 3, 'the corpus no longer carries structurally_inadmissible rows');
  for (const row of inadmissible) {
    assert.deepEqual(pairsOf(judge(row)), [], `${row.rowId}: #39 now reports on a turn that is not one`);
    assert.equal(
      evaluateRubric(row.input).gate,
      'inadmissible',
      `${row.rowId}: nothing now refuses a sentence citing a claim position that does not exist`,
    );
  }

  // PERSISTENCE_CLAIMED — caught by #38's tracking-verb list in English and by
  // #37's per-locale persistence lexicon everywhere. Group 3 counts the half of
  // that sentence that is doing the work.
  const surveillance = rows.filter(
    (row) => row.category === 'surveillance_phrasing' || row.category === 'affixed_surveillance',
  );
  assert.ok(surveillance.length >= 6, 'the corpus no longer carries surveillance rows');
  for (const row of surveillance) {
    assert.deepEqual(pairsOf(judge(row)), [], `${row.rowId}: #39 now reads a promise to watch as a completed write`);
    const codes = rubricLanguagePass(row.input.output, []).map((defect) => defect.code);
    assert.ok(
      codes.includes('COMPLETION_DESCRIBED_AS_TRACKING'),
      `${row.rowId}: no track now catches a false claim of persistence in ${row.locale}`,
    );
  }
});

/* ── 2. The decision-echo path, end to end ───────────────────────── */

/**
 * A hand-built attested act, for the laundering probes below.
 *
 * `rec-coaching-eval` is the corpus's own `RECOMMENDATION_ID`. It is spelled
 * here rather than imported because `evaluationSet.ts` keeps it private — and
 * `buildRow` is exported precisely so a caller can obtain a row without
 * reaching into the module's constants.
 */
function decision(
  optionIndex: number | null,
  verdict: RecommendationDecisionVerdict,
  decidedAt: string,
): RecommendationDecision {
  return {
    version: RECOMMENDATION_CONTRACT_VERSION,
    recommendationId: 'rec-coaching-eval',
    optionIndex,
    verdict,
    decidedAt: decidedAt as Instant,
  };
}

/** A turn that echoes `done` on option 0, run against whatever the caller attests. */
function judgeCompletionEcho(attested: readonly RecommendationDecision[]): SafetyVerdict {
  const row = buildRow('cross-track/echo-done', 'echo_done', 'en', 'clean_control', 'authored');
  const candidate = toSafetyCandidate(row.input.output, 'candidate-echo-done', attested);
  return evaluateSafetyGate({ request: requestWith(attested), candidate, auditId: 'audit-echo-done' }).verdict;
}

test('a fabricated decision echo reaches DECISION_ECHO_UNATTESTED in all three locales', () => {
  // Through the real gateway, over the real corpus rows, in `en`, `ar` and `he`.
  // The locale matters here for the opposite reason it matters in group 3: this
  // code is decided about a *record*, not about words, so it must be exactly as
  // effective in Arabic and Hebrew as in English — and if it ever stops being,
  // the failure is one that group 3's lexicon numbers would not surface.
  const seen = new Set<CoachingLocale>();
  for (const row of defaultCorpus()) {
    if (row.category !== 'fabricated_decision_echo') continue;
    seen.add(row.locale);
    assert.deepEqual(
      pairsOf(judge(row)),
      ['DECISION_ECHO_UNATTESTED@claim:0/segment:null'],
      `${row.rowId}: an echo of a decision the plan acknowledges nothing about was not reported unattested`,
    );
  }
  assert.deepEqual(Array.from(seen).sort(byCodePoint), Array.from(COACHING_LOCALES).sort(byCodePoint));
});

test('a mismatched decision verdict reaches DECISION_ECHO_MISMATCHED in all three locales', () => {
  const seen = new Set<CoachingLocale>();
  for (const row of defaultCorpus()) {
    if (row.category !== 'mismatched_decision_verdict') continue;
    seen.add(row.locale);
    assert.deepEqual(
      pairsOf(judge(row)),
      ['DECISION_ECHO_MISMATCHED@claim:0/segment:null'],
      `${row.rowId}: an echo attributing a different act to the person was not reported mismatched`,
    );
  }
  assert.deepEqual(Array.from(seen).sort(byCodePoint), Array.from(COACHING_LOCALES).sort(byCodePoint));
});

test('a fabricated "done" cannot find a record that launders it', () => {
  // The property #38's `attestationIndexOf` exists for, and the one neither
  // track can demonstrate alone: matching is on `(recommendationId,
  // optionIndex)` and **not** on the verdict. Matching on the verdict is the
  // tempting shortcut, and it destroys the check — an echo claiming `done` would
  // find whichever record happens to say `done`, so `DECISION_ECHO_MISMATCHED`
  // could never fire and every fabricated completion would arrive with an alibi.
  //
  // Each row below is a real `done` record placed somewhere a verdict-matching
  // implementation would happily accept it.
  const cases: readonly {
    readonly name: string;
    readonly attested: readonly RecommendationDecision[];
    readonly expect: readonly string[];
  }[] = [
    {
      name: 'a done record exists, on a different option, while option 0 was only accepted',
      attested: [decision(0, 'accept', '2026-08-19T09:00:00.000Z'), decision(1, 'done', '2026-08-19T09:10:00.000Z')],
      expect: ['DECISION_ECHO_MISMATCHED@claim:0/segment:null'],
    },
    {
      name: 'a done record exists and belongs to another option entirely',
      attested: [decision(1, 'done', '2026-08-19T09:10:00.000Z')],
      expect: ['DECISION_ECHO_UNATTESTED@claim:0/segment:null'],
    },
    {
      name: 'a done record exists against the whole offer rather than an option',
      attested: [decision(null, 'done', '2026-08-19T09:10:00.000Z')],
      expect: ['DECISION_ECHO_UNATTESTED@claim:0/segment:null'],
    },
    {
      name: 'the person deferred option 0 and completed nothing',
      attested: [decision(0, 'defer', '2026-08-19T09:00:00.000Z')],
      expect: ['DECISION_ECHO_MISMATCHED@claim:0/segment:null'],
    },
    {
      name: 'nothing is attested at all',
      attested: [],
      expect: ['DECISION_ECHO_UNATTESTED@claim:0/segment:null'],
    },
    {
      name: 'the done record is dated after the moment being judged',
      attested: [decision(0, 'done', '2026-08-19T11:00:00.000Z')],
      expect: ['DECISION_ECHO_UNATTESTED@claim:0/segment:null'],
    },
  ];

  for (const probe of cases) {
    const verdict = judgeCompletionEcho(probe.attested);
    assert.deepEqual(pairsOf(verdict), Array.from(probe.expect), `laundered: ${probe.name}`);
    assert.equal(verdict.disposition, 'block', `not refused: ${probe.name}`);
  }
});

test('an honest completion echo is allowed, so the refusals above mean something', () => {
  // The falsifier. Without it every assertion in this group is satisfied by a
  // gateway that refuses every echo ever produced, which would be a safety
  // property and a broken product — and indistinguishable from the real one.
  const verdict = judgeCompletionEcho([decision(0, 'done', '2026-08-19T09:00:00.000Z')]);
  assert.deepEqual(pairsOf(verdict), []);
  assert.equal(verdict.disposition, 'allow');
});

test('the same two records in either order give the same verdict', () => {
  // #38 records that taking the *first* match made the answer depend on the
  // order of an array it does not own: `[accept@0, done@0]` blocked an honest
  // completion and the reverse allowed it. The fix — latest by `decidedAt` —
  // lives in `lib/coaching/deliver.ts`, and only a test that runs the gateway
  // afterwards can say whether the verdict is genuinely order-independent.
  const accept = decision(0, 'accept', '2026-08-19T09:00:00.000Z');
  const done = decision(0, 'done', '2026-08-19T09:10:00.000Z');
  assert.deepEqual(pairsOf(judgeCompletionEcho([accept, done])), []);
  assert.deepEqual(pairsOf(judgeCompletionEcho([done, accept])), []);
});

/* ── 3. The multilingual gap, measured rather than assumed ───────── */

/**
 * What each track detects, per locale, on the rows built to attack a lexicon.
 *
 * **These numbers are measurements of the merged code, not targets.** They are
 * asserted so that the gap is a value that changes visibly rather than a
 * sentence in a header that goes quietly false — `lib/safety/lexicon.ts` already
 * says its patterns are English, and a reader has no way to find out what that
 * costs without running exactly this.
 *
 * The columns:
 *
 *  - `gateway` — #39, over #38's converted candidate. English regular
 *    expressions, so `ar` and `he` are zero for both lexical codes it owns.
 *  - `rubric`  — #37's per-locale pass. Non-zero everywhere, which is the point
 *    of #37 having authored Arabic and Hebrew lists at all: it establishes that
 *    the rows really do carry the attack, so a zero in the `gateway` column is a
 *    fact about #39's lexicon and not about the corpus.
 *
 * `COERCIVE_PRESSURE` has no `rubric` counterpart in the language pass — #37
 * scores coercion as a *tone band* on `calmness` rather than as a defect code —
 * so it is measured through `evaluateRubric` in the test below rather than here.
 */
const LEXICAL_DETECTION: readonly {
  readonly code: SafetyReasonCode;
  readonly locale: CoachingLocale;
  readonly rows: number;
  readonly gateway: number;
  readonly rubric: number;
}[] = [
  { code: 'SHAMING_LANGUAGE', locale: 'en', rows: 4, gateway: 4, rubric: 4 },
  { code: 'SHAMING_LANGUAGE', locale: 'ar', rows: 6, gateway: 0, rubric: 6 },
  { code: 'SHAMING_LANGUAGE', locale: 'he', rows: 6, gateway: 0, rubric: 6 },
  { code: 'PERSISTENCE_CLAIMED', locale: 'en', rows: 4, gateway: 0, rubric: 4 },
  { code: 'PERSISTENCE_CLAIMED', locale: 'ar', rows: 6, gateway: 0, rubric: 6 },
  { code: 'PERSISTENCE_CLAIMED', locale: 'he', rows: 6, gateway: 0, rubric: 6 },
];

test('the measured English/Arabic/Hebrew detection counts are what they are', () => {
  const rubricPeer: Readonly<Record<string, string>> = Object.freeze({
    SHAMING_LANGUAGE: 'FORBIDDEN_LANGUAGE',
    PERSISTENCE_CLAIMED: 'COMPLETION_DESCRIBED_AS_TRACKING',
  });

  const measured = new Map<string, { rows: number; gateway: number; rubric: number }>();
  for (const row of defaultCorpus()) {
    for (const code of row.expectation.provokes as readonly string[]) {
      if (rubricPeer[code] === undefined) continue;
      const key = `${code}/${row.locale}`;
      const bucket = measured.get(key) ?? { rows: 0, gateway: 0, rubric: 0 };
      bucket.rows += 1;
      if (pairsOf(judge(row)).some((pair) => pair.startsWith(`${code}@`))) bucket.gateway += 1;
      if (rubricLanguagePass(row.input.output, []).some((defect) => defect.code === rubricPeer[code])) {
        bucket.rubric += 1;
      }
      measured.set(key, bucket);
    }
  }

  for (const expected of LEXICAL_DETECTION) {
    const key = `${expected.code}/${expected.locale}`;
    assert.deepEqual(
      measured.get(key),
      { rows: expected.rows, gateway: expected.gateway, rubric: expected.rubric },
      `the ${expected.locale} detection figures for ${expected.code} moved; re-measure and update ` +
        'LEXICAL_DETECTION deliberately, and say in the commit whether the gap narrowed or widened',
    );
  }
  assert.equal(measured.size, LEXICAL_DETECTION.length, 'a (code, locale) pair appeared that this table does not carry');
});

test("#39's coercion lexicon fires in English and in neither RTL locale, and #37's tone gate fires in all three", () => {
  // The second half of the gap, measured through the instrument that actually
  // owns it. `COERCIVE_PRESSURE` is #39's alone — the product's response engine
  // has no equivalent, as `lib/safety/lexicon.ts` records — so an Arabic
  // ultimatum is refused by nothing downstream of the rubric.
  const gateway = new Map<CoachingLocale, { rows: number; hits: number }>();
  const tone = new Map<CoachingLocale, { rows: number; fails: number }>();

  for (const row of defaultCorpus()) {
    if (row.category !== 'coercive_pressure') continue;
    const g = gateway.get(row.locale) ?? { rows: 0, hits: 0 };
    g.rows += 1;
    if (pairsOf(judge(row)).some((pair) => pair.startsWith('COERCIVE_PRESSURE@'))) g.hits += 1;
    gateway.set(row.locale, g);

    const t = tone.get(row.locale) ?? { rows: 0, fails: 0 };
    t.rows += 1;
    const verdict = evaluateRubric(row.input);
    if (verdict.gate === 'scored' && verdict.tone.some((s) => s.dimension === 'calmness' && s.band === 'fail')) {
      t.fails += 1;
    }
    tone.set(row.locale, t);
  }

  assert.deepEqual(gateway.get('en'), { rows: 2, hits: 2 }, "#39 stopped catching English coercion");
  assert.deepEqual(gateway.get('ar'), { rows: 3, hits: 0 }, 'the Arabic coercion figure moved; re-measure deliberately');
  assert.deepEqual(gateway.get('he'), { rows: 3, hits: 0 }, 'the Hebrew coercion figure moved; re-measure deliberately');

  // And the rows really do carry an ultimatum in all three languages, so the two
  // zeros above are a fact about the lexicon rather than about the corpus.
  assert.deepEqual(tone.get('en'), { rows: 2, fails: 2 });
  assert.deepEqual(tone.get('ar'), { rows: 3, fails: 3 });
  assert.deepEqual(tone.get('he'), { rows: 3, fails: 3 });
});

test('the gap is in the gateway, not in the corpus: every RTL row #39 misses is caught by #37', () => {
  // Stated as one assertion rather than left to be inferred from two tables. If
  // this ever fails the right reading is not "the gap widened" but "an Arabic or
  // Hebrew row stopped attacking anything", which is a corpus defect and a
  // different repair.
  const uncaught: string[] = [];
  for (const row of defaultCorpus()) {
    if (row.locale === 'en') continue;
    const lexical = (row.expectation.provokes as readonly string[]).filter(
      (code) => code === 'SHAMING_LANGUAGE' || code === 'PERSISTENCE_CLAIMED',
    );
    if (lexical.length === 0) continue;
    if (evaluateRubric(row.input).gate === 'scored' && rubricLanguagePass(row.input.output, []).length === 0) {
      uncaught.push(`${row.rowId} [${row.category}/${row.locale}]`);
    }
  }
  assert.deepEqual(uncaught, [], `RTL rows that no track detects at all:\n  ${uncaught.join('\n  ')}`);
});

/* ── 4. The documented disagreements, asserted as disagreements ──── */

const DUE_AT = '2026-08-18T17:00:00.000Z' as Instant;

/** One observed instant, so `resolveEvidenceRoots` has something real to reach. */
function instantGraph(): EvidenceGraph {
  return {
    nodes: [
      {
        kind: 'observed',
        nodeId: 'evd-due',
        source: { kind: 'commitment', commitmentId: 'cmt-cross-track', field: 'due_at' },
        claim: { kind: 'instant', value: DUE_AT },
        observedAt: '2026-08-19T08:00:00.000Z' as Instant,
        valueFingerprint: 'fp-due-cross-track',
      },
    ],
  };
}

function timeCandidate(text: string, statedInstant: Instant): SafetyCandidate {
  return {
    candidateId: 'candidate-instant',
    surface: 'coaching_message',
    segments: [{ role: 'body', text }],
    claims: [
      {
        claimId: 'claim-0',
        kind: 'time',
        statedInstant,
        decisionIndex: null,
        echoedVerdict: null,
        supportedBy: ['evd-due'],
      },
    ],
    evidence: instantGraph(),
    effects: [{ effectId: 'coaching-utterance', kind: 'none', requiresConfirmation: false }],
    pressure: 'none',
  };
}

test("FABRICATED_INSTANT and the engine's ISO-date ban disagree in both directions", () => {
  // Provenance against presentation, and #39's contract says outright that the
  // merge's cross-track test should expect disagreement rather than treat it as
  // a defect. The reason to assert it is that "these two rules agree" is a
  // plausible-sounding cleanup: someone will one day notice that the gateway
  // does not forbid ISO dates and add the pattern, and that change would make
  // a well-sourced date into a safety refusal while doing nothing at all about
  // an invented time written in prose.
  //
  // The engine's patterns are read from the **shipped file** rather than from a
  // copy, on the terms `tests/coaching/claimValidator.test.ts` set: a recorded
  // pattern that has drifted from the source is a claim about a file nobody
  // checked.
  const engineSource = readFileSync(
    join(repoRoot, 'lib', 'services', 'responseEngine', 'validation.ts'),
    'utf8',
  );
  for (const pattern of ENGINE_LEXICON_PARITY.machineTime) {
    assert.ok(
      engineSource.includes(pattern),
      `the engine no longer carries the recorded machine-time pattern ${pattern}; this comparison is stale`,
    );
  }
  const engineForbids = (text: string): boolean =>
    ENGINE_LEXICON_PARITY.machineTime.some((pattern) => new RegExp(pattern, 'i').test(text));

  const gatewayCodes = (candidate: SafetyCandidate): string[] =>
    evaluateSafetyGate({ request: requestWith([]), candidate, auditId: 'audit-instant' })
      .verdict.findings.map((finding) => finding.code)
      .sort(byCodePoint);

  // Direction one: a perfectly sourced instant, written the way a machine writes
  // it. The engine refuses it as scaffolding in prose; the gateway has no
  // opinion, because the time *was* read from something.
  const sourced = 'That one is due 2026-08-18 at 17:00.';
  assert.equal(engineForbids(sourced), true, 'the engine no longer forbids an ISO date in user copy');
  assert.deepEqual(
    gatewayCodes(timeCandidate(sourced, DUE_AT)),
    [],
    'the gateway now refuses a well-sourced instant for the way it is spelled; that is a presentation rule and #39 does not own one',
  );

  // Direction two: an invented time, written the way a person writes one. The
  // engine sees nothing; the gateway refuses it, because no observation the
  // claim rests on carries that moment.
  const invented = 'That one is due next Tuesday in the afternoon.';
  assert.equal(engineForbids(invented), false, 'the engine now forbids prose containing no machine time');
  assert.deepEqual(
    gatewayCodes(timeCandidate(invented, '2026-09-01T15:00:00.000Z' as Instant)),
    ['FABRICATED_INSTANT'],
    'the gateway stopped catching a stated instant that no observation carries',
  );
});

test("echo_kind_not_licensed splits the two checkers: #38's plan pass is silent and #37's faithfulness pass is not", () => {
  // The category #37 calls "the fabricated completion one field from correct".
  // `checkCoachingPlan` verifies that the kind is *some* decision-echo kind and
  // that the verdict matches the plan's; a `user_completed` claim on an `accept`
  // verdict the plan does acknowledge satisfies both, and tells the person they
  // marked something done when they only accepted an offer.
  //
  // Asserted as a **split**, in both directions, so that a future change making
  // the two agree is noticed rather than welcomed. If `checkCoachingPlan` starts
  // reporting it, this file is where the reader finds out that a documented
  // division of labour moved.
  const rows = defaultCorpus().filter((row) => row.category === 'echo_kind_not_licensed');
  assert.ok(rows.length >= 3, 'the corpus no longer carries echo_kind_not_licensed rows');

  const locales = new Set<CoachingLocale>();
  for (const row of rows) {
    locales.add(row.locale);
    assert.deepEqual(
      checkCoachingPlan(row.input.plan).map((defect) => defect.code),
      [],
      `${row.rowId}: #38's checkCoachingPlan now reports on this row; the split this file documents has moved`,
    );
    assert.deepEqual(
      checkCoachingFaithfulness(row.input).map((defect) => `${defect.code}@${defect.claimIndex}`),
      ['CLAIM_KIND_NOT_DERIVABLE@0'],
      `${row.rowId}: #37's faithfulness pass stopped catching an unlicensed echo kind, and nothing else does`,
    );
    // And #39 is silent too, which is why the split matters: with the plan pass
    // quiet, #37 is the only reader standing between this row and a person being
    // told they completed something they merely accepted.
    assert.deepEqual(pairsOf(judge(row)), [], `${row.rowId}: #39 now reports on an unlicensed echo kind`);
  }
  assert.deepEqual(Array.from(locales).sort(byCodePoint), Array.from(COACHING_LOCALES).sort(byCodePoint));
});

/* ── 5. The anti-drift identity ──────────────────────────────────── */

test('PERSISTENCE_LEXICON.en is COACHING_FORBIDDEN_LANGUAGE.trackingVerbs by object identity', () => {
  // `assert.equal`, not `assert.deepEqual`, and the difference is the entire
  // mechanism. A copy that has not drifted yet passes the weaker check, and then
  // drifts on the next edit — which is Sprint 06's recorded failure verbatim:
  // three copies of one lexicon that disagreed on 20 of 31 probed titles, each
  // one deep-equal to the others on the day it was written.
  //
  // Identity makes the drift unrepresentable rather than detectable. #38's list
  // is itself the shipped engine's vocabulary, so this is the last link in a
  // chain that has exactly one source, and it is checked here because it spans
  // two tracks and neither one's suite can see both ends.
  assert.equal(
    PERSISTENCE_LEXICON.en,
    COACHING_FORBIDDEN_LANGUAGE.trackingVerbs,
    "#37's English persistence lexicon is no longer the same object as #38's trackingVerbs; a copy has been introduced and it will drift",
  );
  assert.ok(PERSISTENCE_LEXICON.en.length > 0, 'the shared list is empty, so identity proves nothing');
});

/* ── 6. The suite guards itself ──────────────────────────────────── */

/**
 * Every `tests/safety/*.test.ts` and `tests/coaching/*.test.ts` path named by a
 * package script.
 *
 * Read from the script text rather than from a list kept here: a list kept here
 * would be a third copy of the registration and would drift from both.
 */
function registeredSprintTests(): Set<string> {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const registered = new Set<string>();
  for (const [name, script] of Object.entries(packageJson.scripts)) {
    if (name !== 'test' && name !== 'test:sprint09') continue;
    for (const match of Array.from(script.matchAll(/(tests\/(?:safety|coaching)\/[\w.-]+\.test\.ts)/g))) {
      registered.add(match[1]);
    }
  }
  return registered;
}

function sprintTestsOnDisk(): string[] {
  const found: string[] = [];
  for (const directory of ['safety', 'coaching']) {
    for (const entry of readdirSync(join(repoRoot, 'tests', directory))) {
      if (entry.endsWith('.test.ts')) found.push(`tests/${directory}/${entry}`);
    }
  }
  return found.sort(byCodePoint);
}

test('every registered safety or coaching test file exists on disk', () => {
  // `node --test` skips a missing file among present ones and exits 0 —
  // measured on this runner, not assumed. A typo in the script would delete a
  // track's coverage with no signal at all, and this file was itself the one
  // registered path that did not exist until the merge wrote it.
  const registered = registeredSprintTests();
  assert.ok(
    registered.size >= 12,
    `expected the sprint's safety and coaching files to be registered, found ${registered.size}`,
  );
  const missing = Array.from(registered)
    .filter((file) => !existsSync(join(repoRoot, file)))
    .sort(byCodePoint);
  assert.deepEqual(missing, [], `registered but absent, so silently never run:\n  ${missing.join('\n  ')}`);
});

test('every safety or coaching test file on disk is registered in package.json', () => {
  // The other direction, and the one an existence check cannot see: a file that
  // exists and is registered nowhere runs never, reports nothing, and looks
  // exactly like a file that passes.
  const registered = registeredSprintTests();
  const onDisk = sprintTestsOnDisk();
  assert.ok(onDisk.length >= 12, `only ${onDisk.length} safety and coaching test files were found on disk`);
  const unregistered = onDisk.filter((file) => !registered.has(file));
  assert.deepEqual(
    unregistered,
    [],
    `present on disk and registered in no script, so never run:\n  ${unregistered.join('\n  ')}`,
  );
});

test('the sprint 09 script and the full test script register the same files', () => {
  // Two lists that drift apart mean `npm run test:sprint09` reports green over a
  // subset while `npm test` covers something else — and the sprint gate is the
  // one anybody actually runs while working.
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const filesIn = (script: string): string[] =>
    Array.from(
      new Set(
        Array.from(script.matchAll(/(tests\/(?:safety|coaching)\/[\w.-]+\.test\.ts)/g)).map((match) => match[1]),
      ),
    ).sort(byCodePoint);

  assert.deepEqual(
    filesIn(packageJson.scripts['test:sprint09']),
    filesIn(packageJson.scripts.test),
    'test:sprint09 and test cover different safety and coaching files',
  );
});
