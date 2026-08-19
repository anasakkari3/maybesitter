/**
 * Next-step selection must not depend on the runtime's locale.
 *
 * Found while surveying the recommendation surface for Sprint 08, not by a
 * failing suite: both next-step selectors broke a tie with
 * `String.prototype.localeCompare`, whose no-argument form resolves against the
 * host's default locale. That makes *which commitment the user is shown* a
 * function of `LANG`/`LC_ALL` on the machine that happened to serve the request.
 *
 * The repo already holds this rule in four other modules, each stating it in as
 * many words — `lib/runtimeMemory/runtimeMemoryStore.ts`, `lib/lifeState/fields.ts`,
 * `lib/feedback/feedbackEventStore.ts`, and `lib/planning/shared/compare.ts`,
 * whose `compareByCodePoint` exists precisely so a fifth spelling does not. The
 * two next-step call sites predate that consolidation.
 *
 * Measured on this runtime, and the reason the ids below are shaped as they are:
 *
 *     en-US      i-ITEM < I-item
 *     tr-TR      I-item < i-ITEM      ← flips
 *     code unit  I-item < i-ITEM      ('I' is U+0049, 'i' is U+0069)
 *
 * So a test that pins the code-unit answer fails under the old comparator on an
 * ordinary en-US host, rather than only on a Turkish one. That matters: a test
 * that only failed under an exotic locale would be a test nobody ever saw fail.
 *
 * This file is deliberately locale-agnostic in *how* it asserts. It does not set
 * `LANG` or construct an `Intl.Collator`; it pins the one total order the code is
 * allowed to have, which is the property that makes the locale question moot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { proposeNextStep, type NextStepCandidate } from '../../lib/services/nextStepReviewService.ts';
import { selectNextStepForArm, type ArmCandidate } from '../../lib/experiments/nextStepArms.ts';
import { NEXT_STEP_BASELINE_ARM } from '../../src/contracts/v1/experimentContracts.ts';
import { selectBaselineNextStep } from '../../lib/services/nextStepBaseline.ts';

/**
 * Two ids that a locale-aware comparator and a code-unit comparator disagree
 * about. Uppercase `I` sorts before lowercase `i` by code unit; most locales
 * fold case and put `i-ITEM` first.
 */
const UPPER_FIRST = 'I-item';
const LOWER_FIRST = 'i-ITEM';

function candidate(commitmentId: string, rank: number): NextStepCandidate {
  return {
    commitmentId,
    title: `step ${commitmentId}`,
    // A non-empty, safe reason: an empty one is read as insufficient evidence
    // and returns no primary step at all, which would make the tie-break below
    // unreachable and the assertion vacuous.
    reason: 'due today',
    evidenceLabels: ['due today'],
    rank,
  };
}

test('the two ids actually separate a locale-aware comparator from a code-unit one', () => {
  // Without this the tests below could pass against any comparator at all,
  // including the one they exist to forbid.
  const byCodeUnit = [LOWER_FIRST, UPPER_FIRST].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(byCodeUnit, [UPPER_FIRST, LOWER_FIRST], 'code-unit order must put the uppercase id first');
  // Explicit locale, not the ambient one. This assertion exists to prove the
  // two ids separate the comparators — but a no-argument `localeCompare` is the
  // very call this file forbids, and reading the host's locale here made the
  // guard itself locale-dependent: it went red under LC_ALL=tr_TR, which is the
  // locale the fix was motivated by.
  assert.equal(
    LOWER_FIRST.localeCompare(UPPER_FIRST, 'en-US') < 0,
    true,
    'these ids no longer disagree under en-US collation; pick ids that do',
  );
});

test('proposeNextStep breaks a rank tie by code unit, not by locale', () => {
  // Equal rank, so the tie-break alone decides which commitment the user sees.
  const proposal = proposeNextStep(
    [candidate(LOWER_FIRST, 1), candidate(UPPER_FIRST, 1)],
    'en',
    'proposal-1',
  );
  assert.equal(proposal.primaryStep?.commitmentId, UPPER_FIRST);
});

test('proposeNextStep is unaffected by the order the candidates arrive in', () => {
  const forward = proposeNextStep([candidate(LOWER_FIRST, 1), candidate(UPPER_FIRST, 1)], 'en', 'p');
  const reversed = proposeNextStep([candidate(UPPER_FIRST, 1), candidate(LOWER_FIRST, 1)], 'en', 'p');
  assert.deepEqual(reversed, forward);
});

function context() {
  return {
    now: new Date('2026-11-24T09:00:00.000Z'),
    locale: 'en' as const,
    proposalId: 'p-1',
    timezone: 'UTC',
  };
}

function armCandidate(commitmentId: string): ArmCandidate {
  return {
    commitmentId,
    title: `step ${commitmentId}`,
    confirmed: true,
    status: 'active',
    dueAt: '2026-11-24T10:00:00.000Z',
    remindAt: null,
    importance: null,
    explicitEffortMinutes: 30,
    kind: 'task',
  };
}

test('the baseline arm breaks a fully-tied score by code unit, not by locale', () => {
  // Reaches `nextStepBaseline.compareScores`. `selectNextStepForArm` returns
  // early for the baseline arm, so this case never touches `nextStepArms`.
  const selection = selectNextStepForArm(
    NEXT_STEP_BASELINE_ARM,
    [armCandidate(LOWER_FIRST), armCandidate(UPPER_FIRST)],
    context(),
  );
  assert.equal(selection.selectedCommitmentId, UPPER_FIRST);
});

test('an adjusted arm breaks a fully-tied score by code unit, not by locale', () => {
  // Reaches `nextStepArms.baselineOrder`, which the baseline arm never calls:
  //
  //     const baseline = selectBaselineNextStep(...);
  //     if (arm === NEXT_STEP_BASELINE_ARM) return { arm, ...baseline, ... };
  //
  // This case exists because the file had a *third* instance of the defect it
  // narrates. An earlier draft named the arm with a string literal that is not
  // a valid arm; correcting it to the exported constant moved the test onto the
  // early-return path and silently off the module it is named for. Reverting
  // the `nextStepArms` comparator alone left every assertion here green.
  //
  // The general rule, learned twice in one file: mutate **one site at a time**.
  // Reverting all of them together passes as long as any single site is pinned.
  const selection = selectNextStepForArm(
    'contextual',
    [armCandidate(LOWER_FIRST), armCandidate(UPPER_FIRST)],
    context(),
  );
  assert.equal(selection.selectedCommitmentId, UPPER_FIRST);
});

test('the returned score listing is ordered by code unit, not by locale', () => {
  // The fourth site. It orders `BaselineSelection.scores` rather than deciding
  // the selection, so none of the assertions above reach it — reverting it alone
  // left all of them green. That is the whole argument for mutating one site at
  // a time: a suite can pin three of four comparators and read as complete.
  //
  // The listing is output the caller receives and may render, so a host-locale
  // dependency here is a difference two deployments would disagree about even
  // when they select the same commitment.
  const selection = selectBaselineNextStep(
    [armCandidate(LOWER_FIRST), armCandidate(UPPER_FIRST)],
    new Date('2026-11-24T09:00:00.000Z'),
    'en',
    'p-1',
  );
  assert.deepEqual(
    selection.scores.map((score) => score.commitmentId),
    [UPPER_FIRST, LOWER_FIRST],
  );
});
