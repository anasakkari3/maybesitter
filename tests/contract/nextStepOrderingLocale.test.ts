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
  assert.equal(
    LOWER_FIRST.localeCompare(UPPER_FIRST) < 0,
    true,
    'these ids no longer disagree under this runtime\'s default locale; pick ids that do',
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

test('the arm selector breaks a fully-tied score by code unit, not by locale', () => {
  // Every band is equal by construction, so `baselineOrder` reaches its final
  // key — the one this fix is about — and nothing else can decide the outcome.
  const selection = selectNextStepForArm(
    // The baseline arm is spelled 'generic'; naming it by the exported constant
    // rather than by its string keeps this test on the branch it means to probe.
    // A literal here silently fell through to the adjusted-arm path.
    NEXT_STEP_BASELINE_ARM,
    [armCandidate(LOWER_FIRST), armCandidate(UPPER_FIRST)],
    {
      now: new Date('2026-11-24T09:00:00.000Z'),
      locale: 'en',
      proposalId: 'p-1',
      timezone: 'UTC',
    },
  );
  assert.equal(selection.selectedCommitmentId, UPPER_FIRST);
});
