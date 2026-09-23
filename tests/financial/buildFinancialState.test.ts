/**
 * The builder: pure arithmetic over resolved fields, and the places it
 * refuses to produce a number.
 *
 * Most of these tests are about the refusals. A financial summary that fills
 * a gap with a plausible zero is worse than one that says it does not know,
 * because the person reading it cannot tell the two apart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinancialState } from '../../lib/services/financial/buildFinancialState.ts';
import type { NormalizedFinancialObservations } from '../../lib/integrations/financial/adapter.ts';
import type { ManualFinancialInputs } from '../../lib/services/financial/manualFinancialInputs.ts';

const SCOPE = 'user-fin-1';
const CONNECTION = 'conn-fin-1';
const AS_OF = '2026-09-23T09:00:00.000Z';

function observed(over: Partial<NormalizedFinancialObservations> = {}): NormalizedFinancialObservations {
  const e = <T extends number | string>(value: T, confidence = 0.9) => ({
    value, observedAt: AS_OF, confidence, connectionId: CONNECTION,
  });
  return {
    connectionId: CONNECTION,
    observedAt: AS_OF,
    currency: e('ILS', 0.95),
    cashAvailable: e(180_000, 0.95),
    nextIncomeAt: e('2026-09-28T00:00:00.000Z'),
    nextIncomeAmount: e(820_000),
    fixedMonthlyObligations: e(490_000),
    recurringCount: e(7),
    obligations: [
      { obligationId: 'ob-card', category: 'card', dueAt: '2026-09-25T00:00:00.000Z', amountMinorUnits: 90_000, currency: 'ILS', recurring: true },
      { obligationId: 'ob-net', category: 'subscription', dueAt: '2026-09-26T00:00:00.000Z', amountMinorUnits: 45_000, currency: 'ILS', recurring: true },
      { obligationId: 'ob-rent', category: 'rent', dueAt: '2026-10-01T00:00:00.000Z', amountMinorUnits: 350_000, currency: 'ILS', recurring: true },
    ],
    injectionSignals: [],
    trust: 'untrusted_external_content',
    privilegedActionAllowed: false,
    ...over,
  };
}

const NO_MANUAL: ManualFinancialInputs = { fields: [], obligations: [] };

/* ── The headline arithmetic ──────────────────────────────────────── */

test('the buffer is the cash left after what falls due before the next income', () => {
  const state = buildFinancialState({ scopeId: SCOPE, asOf: AS_OF, observations: [observed()], manual: NO_MANUAL });
  // 90,000 on the 25th and 45,000 on the 26th fall before the 28th; the rent
  // on the 1st does not.
  assert.equal(state.obligationsBeforeNextIncome?.minorUnits, 135_000);
  assert.equal(state.freeBuffer?.minorUnits, 45_000);
  assert.equal(state.freeBuffer?.currency, 'ILS');
});

test('a buffer that small against that much due is tight, not comfortable', () => {
  const state = buildFinancialState({ scopeId: SCOPE, asOf: AS_OF, observations: [observed()], manual: NO_MANUAL });
  assert.equal(state.bufferBand, 'tight');
});

test('more cash than is due is comfortable', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF,
    observations: [observed({ cashAvailable: { value: 900_000, observedAt: AS_OF, confidence: 0.95, connectionId: CONNECTION } })],
    manual: NO_MANUAL,
  });
  assert.equal(state.bufferBand, 'comfortable');
});

test('owing more than is there is negative, and the number is allowed to be negative', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF,
    observations: [observed({ cashAvailable: { value: 100_000, observedAt: AS_OF, confidence: 0.95, connectionId: CONNECTION } })],
    manual: NO_MANUAL,
  });
  assert.equal(state.freeBuffer?.minorUnits, -35_000);
  assert.equal(state.bufferBand, 'negative');
});

/* ── The refusals ─────────────────────────────────────────────────── */

test('with no next income date, "due before it" has no answer and is not faked', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF,
    observations: [observed({ nextIncomeAt: null, nextIncomeAmount: null })],
    manual: NO_MANUAL,
  });
  assert.equal(state.obligationsBeforeNextIncome, null);
  assert.equal(state.freeBuffer, null);
  assert.equal(state.bufferBand, 'unknown');
});

test('with no currency there are no amounts', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF,
    observations: [observed({ currency: null })],
    manual: NO_MANUAL,
  });
  assert.equal(state.currency, null);
  assert.equal(state.cashAvailable, null);
  assert.equal(state.bufferBand, 'unknown');
});

test('obligations in a second currency are not silently dropped out of the total', () => {
  const base = observed();
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF,
    observations: [observed({
      obligations: [...base.obligations.slice(0, 1), { ...base.obligations[1]!, currency: 'USD' }],
    })],
    manual: NO_MANUAL,
  });
  assert.equal(state.obligationsBeforeNextIncome, null, 'a partial total reads as a complete one');
  assert.equal(state.bufferBand, 'unknown');
});

test('nothing at all is a state full of nulls, not a state full of zeroes', () => {
  const state = buildFinancialState({ scopeId: SCOPE, asOf: AS_OF, observations: [], manual: NO_MANUAL });
  assert.equal(state.cashAvailable, null);
  assert.equal(state.freeBuffer, null);
  assert.equal(state.bufferBand, 'unknown');
  assert.deepEqual([...state.sourceKinds], []);
  assert.deepEqual([...state.missingSourceKinds].sort(), ['manual', 'provider']);
});

/* ── Provenance ───────────────────────────────────────────────────── */

test('a computed value is attributed to computation, and names what fed it', () => {
  const state = buildFinancialState({ scopeId: SCOPE, asOf: AS_OF, observations: [observed()], manual: NO_MANUAL });
  assert.equal(state.freeBuffer?.provenance.origin, 'computed');
  assert.deepEqual([...state.freeBuffer!.provenance.contributingSources], ['provider']);
});

test('a computed value is only as fresh and as sure as its stalest, least certain input', () => {
  const stale = { value: 180_000, observedAt: '2026-09-16T00:00:00.000Z', confidence: 0.4, connectionId: CONNECTION };
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF,
    observations: [observed({ cashAvailable: stale })],
    manual: NO_MANUAL,
  });
  assert.equal(state.freeBuffer?.provenance.observedAt, '2026-09-16T00:00:00.000Z');
  assert.equal(state.freeBuffer?.provenance.confidence, 0.4);
});

/* ── Both sources ─────────────────────────────────────────────────── */

test('a savings goal is the user\'s to state, and the state says so', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF,
    observations: [observed()],
    manual: { fields: [{ field: 'savings_goal', kind: 'statement', value: 1_500_000, observedAt: '2026-01-01T00:00:00.000Z' }], obligations: [] },
  });
  assert.equal(state.savingsGoal?.minorUnits, 1_500_000);
  assert.equal(state.savingsGoal?.provenance.origin, 'manual');
  assert.deepEqual([...state.sourceKinds].sort(), ['manual', 'provider']);
});

test('a correction reaches the state, and the overruled reading is in the conflicts', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF,
    observations: [observed()],
    manual: { fields: [{ field: 'cash_available', kind: 'correction', value: 60_000, observedAt: '2026-09-24T00:00:00.000Z' }], obligations: [] },
  });
  assert.equal(state.cashAvailable?.minorUnits, 60_000);
  assert.equal(state.conflicts.length, 1);
  assert.equal(state.conflicts[0]!.field, 'cash_available');
  assert.equal(state.conflicts[0]!.providerValue, 180_000);
});

test('a hand-entered bill is shown with its label; a detected one stays anonymous', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF,
    observations: [observed()],
    manual: {
      fields: [],
      obligations: [{
        obligationId: 'manual-tuition', label: 'Semester B tuition', category: 'tuition',
        dueAt: '2026-09-27T00:00:00.000Z', amountMinorUnits: 200_000, currency: 'ILS',
        recurring: false, observedAt: '2026-09-01T00:00:00.000Z',
      }],
    },
  });
  const tuition = state.upcomingObligations.find((o) => o.obligationId === 'manual-tuition');
  assert.equal(tuition?.label, 'Semester B tuition');
  assert.equal(state.upcomingObligations.find((o) => o.obligationId === 'ob-rent')?.label, null);
  assert.equal(state.obligationsBeforeNextIncome?.minorUnits, 335_000, 'the hand-entered bill was left out of the total');
});

/* ── Time, and only time ──────────────────────────────────────────── */

test('obligations already paid are not still upcoming', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: '2026-09-27T00:00:00.000Z',
    observations: [observed()], manual: NO_MANUAL,
  });
  const ids = state.upcomingObligations.map((o) => o.obligationId);
  assert.ok(!ids.includes('ob-card'), 'the 25th is behind us');
  assert.ok(ids.includes('ob-rent'));
});

test('the same inputs and the same asOf produce byte-identical states', () => {
  const input = { scopeId: SCOPE, asOf: AS_OF, observations: [observed()], manual: NO_MANUAL };
  assert.equal(JSON.stringify(buildFinancialState(input)), JSON.stringify(buildFinancialState(input)));
});

test('moving only asOf across payday changes the picture', () => {
  const before = buildFinancialState({ scopeId: SCOPE, asOf: AS_OF, observations: [observed()], manual: NO_MANUAL });
  const after = buildFinancialState({ scopeId: SCOPE, asOf: '2026-09-29T00:00:00.000Z', observations: [observed()], manual: NO_MANUAL });
  assert.equal(before.bufferBand, 'tight');
  assert.equal(after.obligationsBeforeNextIncome, null, 'the predicted payday is behind us now');
  assert.notEqual(JSON.stringify(before), JSON.stringify(after));
});

test('asOf is carried into the state, so a reader never has to guess when it was true', () => {
  const state = buildFinancialState({ scopeId: SCOPE, asOf: AS_OF, observations: [observed()], manual: NO_MANUAL });
  assert.equal(state.asOf, AS_OF);
  assert.equal(state.scopeId, SCOPE);
});

test('a payday that has already passed is not a next income', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: '2026-09-29T00:00:00.000Z',
    observations: [observed()], manual: NO_MANUAL,
  });
  assert.equal(state.nextIncomeAt, null, 'a date in the past was still being called the next one');
  assert.equal(state.nextIncomeAmount, null);
  assert.equal(state.obligationsBeforeNextIncome, null);
});

test('nothing due before a payday that is genuinely ahead is a confident zero', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: '2026-09-27T00:00:00.000Z',
    observations: [observed()], manual: NO_MANUAL,
  });
  assert.equal(state.obligationsBeforeNextIncome?.minorUnits, 0);
  assert.equal(state.obligationsBeforeNextIncome?.provenance.observedAt, AS_OF, 'an empty window still has a provenance');
  assert.equal(state.bufferBand, 'comfortable');
});

test('with no bank and no currency field, the currency comes from the user\'s own bills', () => {
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF, observations: [],
    manual: {
      fields: [{ field: 'next_income_at', kind: 'statement', value: '2026-09-28T00:00:00.000Z', observedAt: '2026-09-01T00:00:00.000Z' }],
      obligations: [{
        obligationId: 'manual-tuition', label: 'Tuition', category: 'tuition',
        dueAt: '2026-09-27T00:00:00.000Z', amountMinorUnits: 200_000, currency: 'ILS',
        recurring: false, observedAt: '2026-09-01T00:00:00.000Z',
      }],
    },
  });
  assert.equal(state.currency, 'ILS');
  assert.equal(state.obligationsBeforeNextIncome?.minorUnits, 200_000);
});

test('bills in two currencies leave the account currency unanswered', () => {
  const row = {
    label: 'Bill', category: 'other' as const, dueAt: '2026-09-27T00:00:00.000Z',
    amountMinorUnits: 1_000, recurring: false, observedAt: '2026-09-01T00:00:00.000Z',
  };
  const state = buildFinancialState({
    scopeId: SCOPE, asOf: AS_OF, observations: [],
    manual: {
      fields: [],
      obligations: [
        { ...row, obligationId: 'a', currency: 'ILS' },
        { ...row, obligationId: 'b', currency: 'USD' },
      ],
    },
  });
  assert.equal(state.currency, null);
});
