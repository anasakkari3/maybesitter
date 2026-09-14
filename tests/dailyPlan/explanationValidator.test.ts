/**
 * What the model is allowed to say about a plan (UC-3.10a, #194).
 *
 * Three of these are acceptance criteria in their own right: a time that is not
 * in the plan, a title nobody committed to, and a §13 forbidden phrase each
 * have to be refused, and each is one test rather than a row in a list, because
 * the issue asks for a test per case.
 *
 * The template is then checked *against the same validator*, in all three
 * locales. That closes the loop the whole design rests on: the fallback is only
 * safe if the fallback itself would pass, and a template that quietly violated
 * its own rules would be shipped to every user whose model call failed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXPLANATION_CHARS,
  explanationFactsFrom,
  explanationRejections,
  isValidExplanation,
  templateExplanation,
  type ExplanationFacts,
} from '../../lib/services/dailyPlan/explanationValidator.ts';
import type { Plan } from '../../src/contracts/v1/planningContracts.ts';

const TZ = 'Asia/Jerusalem';

/** 09:00-09:30 and 11:00-11:30 local, which is 06:00Z and 08:00Z in September. */
const PLAN: Plan = {
  version: 1,
  schema: 'planning-v1',
  scopeId: 'u:2026-09-15',
  horizon: { startsAt: '2026-09-14T21:00:00.000Z', endsAt: '2026-09-15T21:00:00.000Z' },
  scheduled: [
    {
      itemId: 'c1',
      interval: { startsAt: '2026-09-15T06:00:00.000Z', endsAt: '2026-09-15T06:30:00.000Z' },
      reservedInterval: { startsAt: '2026-09-15T06:00:00.000Z', endsAt: '2026-09-15T06:30:00.000Z' },
    },
    {
      itemId: 'c2',
      interval: { startsAt: '2026-09-15T08:00:00.000Z', endsAt: '2026-09-15T08:30:00.000Z' },
      reservedInterval: { startsAt: '2026-09-15T08:00:00.000Z', endsAt: '2026-09-15T08:30:00.000Z' },
    },
  ],
  unscheduled: [
    { itemId: 'c3', reason: { code: 'NO_FEASIBLE_SLOT', itemId: 'c3', detail: 'no room left' } },
  ],
  constraintReasons: [],
  inputDigest: 'digest-1',
} as unknown as Plan;

const TITLES = new Map([['c1', 'Write the summary'], ['c2', 'Call the bank'], ['c3', 'Book the train']]);

function facts(locale: 'ar' | 'he' | 'en' = 'en'): ExplanationFacts {
  return explanationFactsFrom(PLAN, TITLES, TZ, locale);
}

test('the facts are read off the plan, in the user\'s zone', () => {
  const derived = facts();
  assert.deepEqual([...derived.allowedTimes].sort(), ['09:00', '09:30', '11:00', '11:30']);
  assert.equal(derived.scheduledCount, 2);
  assert.equal(derived.unscheduledCount, 1);
  assert.equal(derived.firstStart, '09:00');
  assert.equal(derived.lastEnd, '11:30');
});

/* ── The three acceptance cases ──────────────────────────────────── */

test('a time that is not in the plan is refused', () => {
  const text = 'I placed 2 things between 09:00 and 14:45. 1 did not fit today.';
  assert.deepEqual(explanationRejections(text, facts()), ['time_not_in_plan']);
});

test('an invented title is refused', () => {
  const text = 'I placed 2 things between 09:00 and 11:30, including "Pick up the dry cleaning".';
  assert.deepEqual(explanationRejections(text, facts()), ['unknown_title']);
});

test('a §13 forbidden phrase is refused', () => {
  const text = 'I placed 2 things between 09:00 and 11:30. I manage your entire life from here.';
  assert.deepEqual(explanationRejections(text, facts()), ['prohibited_claim']);
});

/* ── The rest of the reject matrix ───────────────────────────────── */

test('a count that is neither the placed nor the unplaced number is refused', () => {
  assert.deepEqual(
    explanationRejections('I placed 7 things between 09:00 and 11:30.', facts()),
    ['count_mismatch'],
  );
});

test('shame, coercion and a persistence claim are each refused', () => {
  assert.deepEqual(explanationRejections('You always let this slip.', facts()), ['shame']);
  assert.deepEqual(explanationRejections('You have to do this one first.', facts()), ['coercion']);
  assert.deepEqual(
    explanationRejections('I have scheduled these for you.', facts()),
    ['persistence_claim'],
  );
});

test('an empty answer and an over-long one are refused', () => {
  assert.deepEqual(explanationRejections('   ', facts()), ['empty']);
  assert.deepEqual(explanationRejections(null, facts()), ['empty']);
  const long = `Your day starts at 09:00. ${'a'.repeat(MAX_EXPLANATION_CHARS)}`;
  assert.ok(explanationRejections(long, facts()).includes('too_long'));
});

test('every reason is reported, not just the first', () => {
  const text = 'You always slip. I placed 9 things at 03:15.';
  const reasons = explanationRejections(text, facts());
  assert.ok(reasons.includes('time_not_in_plan'));
  assert.ok(reasons.includes('count_mismatch'));
  assert.ok(reasons.includes('shame'));
});

test('a quoted fragment that really is one of the titles is accepted', () => {
  assert.equal(
    isValidExplanation('I placed 2 things. "Call the bank" is at 11:00.', facts()),
    true,
  );
});

test('a capitalised run that opens a sentence is not read as a title', () => {
  assert.equal(isValidExplanation('Today Is quiet. I placed 2 things.', facts()), true);
});

/* ── The template passes its own validator, in every locale ──────── */

for (const locale of ['ar', 'he', 'en'] as const) {
  test(`the ${locale} template is itself a valid explanation`, () => {
    const derived = facts(locale);
    const text = templateExplanation(derived);
    assert.ok(text.length > 0);
    assert.deepEqual(
      explanationRejections(text, derived),
      [],
      `the ${locale} template does not pass the validator that guards the model: ${text}`,
    );
  });
}

test('the template says something true when nothing was placed', () => {
  const empty: ExplanationFacts = {
    locale: 'en',
    allowedTimes: [],
    titles: [],
    scheduledCount: 0,
    unscheduledCount: 3,
    firstStart: null,
    lastEnd: null,
  };
  const text = templateExplanation(empty);
  assert.match(text, /Nothing fits/);
  assert.deepEqual(explanationRejections(text, empty), []);
});

test('the template says nothing about leftovers when there are none', () => {
  const clean: ExplanationFacts = { ...facts(), unscheduledCount: 0 };
  assert.deepEqual(explanationRejections(templateExplanation(clean), clean), []);
});
