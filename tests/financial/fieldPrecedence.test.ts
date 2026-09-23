/**
 * The precedence rule, stated as the cases that would otherwise be argued
 * about six months from now.
 *
 * The rule under test is that authority follows the *field*, never the clock.
 * Recency exists, but only inside one source: a fresher bank reading beats a
 * staler bank reading and a newer thing the user said beats an older thing
 * they said, and neither ever reaches across to the other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FINANCIAL_FIELD_AUTHORITY,
  FINANCIAL_FIELD_IDS,
} from '../../src/contracts/v1/financialContracts.ts';
import {
  resolveFinancialField,
  type FinancialManualEntry,
  type FinancialObservationEntry,
} from '../../lib/services/financial/fieldPrecedence.ts';

const CONNECTION = 'conn-sandbox-1';

function observed(value: number | string, observedAt: string, confidence = 0.9): FinancialObservationEntry<number | string> {
  return { value, observedAt, confidence, connectionId: CONNECTION };
}

function stated(value: number | string, observedAt: string): FinancialManualEntry<number | string> {
  return { value, observedAt, confidence: 1, connectionId: null, kind: 'statement' };
}

function corrected(value: number | string, observedAt: string): FinancialManualEntry<number | string> {
  return { value, observedAt, confidence: 1, connectionId: null, kind: 'correction' };
}

/* ── The table is the rule ────────────────────────────────────────── */

test('every declared field has exactly one declared authority', () => {
  assert.deepEqual(
    Object.keys(FINANCIAL_FIELD_AUTHORITY).sort(),
    [...FINANCIAL_FIELD_IDS].sort(),
    'a field with no authority row would be resolved by whatever the code happened to do',
  );
});

/* ── One source, or none ──────────────────────────────────────────── */

test('nothing from either source is null, not a fabricated zero', () => {
  const result = resolveFinancialField({ field: 'cash_available', provider: [], manual: [] });
  assert.equal(result.value, null);
  assert.equal(result.provenance, null);
  assert.equal(result.conflict, null);
});

test('a provider-owned field with only a provider reading takes it', () => {
  const result = resolveFinancialField({
    field: 'cash_available',
    provider: [observed(180_000, '2026-09-23T06:00:00.000Z')],
    manual: [],
  });
  assert.equal(result.value, 180_000);
  assert.equal(result.provenance?.origin, 'provider');
  assert.equal(result.provenance?.connectionId, CONNECTION);
  assert.equal(result.conflict, null);
});

test('a provider-owned field with only a manual statement falls back to it, with no conflict', () => {
  const result = resolveFinancialField({
    field: 'cash_available',
    provider: [],
    manual: [stated(180_000, '2026-09-23T06:00:00.000Z')],
  });
  assert.equal(result.value, 180_000);
  assert.equal(result.provenance?.origin, 'manual');
  assert.equal(result.provenance?.connectionId, null);
  assert.equal(result.conflict, null, 'there is nothing for a lone value to disagree with');
});

/* ── Recency, but only within a source ────────────────────────────── */

test('a newer provider reading supersedes an older provider reading', () => {
  const result = resolveFinancialField({
    field: 'cash_available',
    provider: [
      observed(90_000, '2026-09-20T06:00:00.000Z'),
      observed(180_000, '2026-09-23T06:00:00.000Z'),
      observed(120_000, '2026-09-21T06:00:00.000Z'),
    ],
    manual: [],
  });
  assert.equal(result.value, 180_000);
  assert.equal(result.provenance?.observedAt, '2026-09-23T06:00:00.000Z');
});

test('a newer manual statement supersedes an older manual statement', () => {
  const result = resolveFinancialField({
    field: 'savings_goal',
    provider: [],
    manual: [
      stated(1_000_000, '2026-08-01T00:00:00.000Z'),
      stated(1_500_000, '2026-09-01T00:00:00.000Z'),
    ],
  });
  assert.equal(result.value, 1_500_000);
});

test('two readings from one source at the same instant resolve the same way every time', () => {
  const entries = [observed(180_000, '2026-09-23T06:00:00.000Z'), observed(90_000, '2026-09-23T06:00:00.000Z')];
  const first = resolveFinancialField({ field: 'cash_available', provider: entries, manual: [] });
  const second = resolveFinancialField({ field: 'cash_available', provider: [...entries].reverse(), manual: [] });
  assert.equal(first.value, second.value, 'input order decided the answer');
});

/* ── Both sources, no correction ──────────────────────────────────── */

test('agreement is not a conflict', () => {
  const result = resolveFinancialField({
    field: 'cash_available',
    provider: [observed(180_000, '2026-09-23T06:00:00.000Z')],
    manual: [stated(180_000, '2026-09-22T00:00:00.000Z')],
  });
  assert.equal(result.value, 180_000);
  assert.equal(result.conflict, null);
});

test('on an observed fact the provider wins, and the manual value stays visible', () => {
  const result = resolveFinancialField({
    field: 'cash_available',
    provider: [observed(180_000, '2026-09-23T06:00:00.000Z')],
    manual: [stated(150_000, '2026-09-22T00:00:00.000Z')],
  });
  assert.equal(result.value, 180_000);
  assert.equal(result.provenance?.origin, 'provider');
  assert.deepEqual(result.conflict, {
    field: 'cash_available',
    providerValue: 180_000,
    manualValue: 150_000,
    resolvedTo: 'provider',
    reason: 'provider_authoritative_for_observed_fact',
  });
});

/* ── User intent ──────────────────────────────────────────────────── */

test('on user intent the user wins, and the provider value stays visible', () => {
  const result = resolveFinancialField({
    field: 'savings_goal',
    provider: [observed(500_000, '2026-09-23T06:00:00.000Z')],
    manual: [stated(1_500_000, '2026-01-01T00:00:00.000Z')],
  });
  assert.equal(result.value, 1_500_000);
  assert.equal(result.provenance?.origin, 'manual');
  assert.equal(result.conflict?.reason, 'manual_authoritative_for_user_intent');
  assert.equal(result.conflict?.resolvedTo, 'manual');
});

/* ── The case the whole design exists for ─────────────────────────── */

test('a correction beats a provider reading taken AFTER it', () => {
  const result = resolveFinancialField({
    field: 'cash_available',
    provider: [observed(180_000, '2026-09-30T06:00:00.000Z')],
    manual: [corrected(150_000, '2026-09-23T00:00:00.000Z')],
  });
  assert.equal(result.value, 150_000, 'a later sync silently undid what the user said');
  assert.equal(result.provenance?.origin, 'manual');
  assert.equal(result.conflict?.reason, 'user_correction_overrides_observation');
  assert.equal(result.conflict?.providerValue, 180_000, 'the overruled reading must stay visible');
});

test('a correction still loses nothing when many newer provider readings arrive', () => {
  const result = resolveFinancialField({
    field: 'cash_available',
    provider: [
      observed(180_000, '2026-09-30T06:00:00.000Z'),
      observed(181_000, '2026-10-30T06:00:00.000Z'),
      observed(182_000, '2026-11-30T06:00:00.000Z'),
    ],
    manual: [corrected(150_000, '2026-09-23T00:00:00.000Z')],
  });
  assert.equal(result.value, 150_000);
});

test('a correction only moves the field it names', () => {
  const corrections = resolveFinancialField({
    field: 'cash_available',
    provider: [observed(180_000, '2026-09-30T06:00:00.000Z')],
    manual: [corrected(150_000, '2026-09-23T00:00:00.000Z')],
  });
  const untouched = resolveFinancialField({
    field: 'fixed_monthly_obligations',
    provider: [observed(490_000, '2026-09-30T06:00:00.000Z')],
    manual: [stated(400_000, '2026-09-23T00:00:00.000Z')],
  });
  assert.equal(corrections.provenance?.origin, 'manual');
  assert.equal(untouched.provenance?.origin, 'provider', 'one correction moved a field it never named');
});

test('a plain statement made after a correction hands the field back to the provider', () => {
  // The documented undo path: the newest thing the user said decides, and the
  // UI records an edit to a provider-owned field as a correction. A later
  // plain statement is the user stepping back out of the way.
  const result = resolveFinancialField({
    field: 'cash_available',
    provider: [observed(180_000, '2026-09-30T06:00:00.000Z')],
    manual: [
      corrected(150_000, '2026-09-23T00:00:00.000Z'),
      stated(160_000, '2026-09-24T00:00:00.000Z'),
    ],
  });
  assert.equal(result.value, 180_000);
  assert.equal(result.conflict?.reason, 'provider_authoritative_for_observed_fact');
});

/* ── Strings resolve the same way as numbers ──────────────────────── */

test('a currency disagreement is a conflict, not a quiet pick', () => {
  const result = resolveFinancialField({
    field: 'currency',
    provider: [observed('ILS', '2026-09-23T06:00:00.000Z')],
    manual: [stated('USD', '2026-09-01T00:00:00.000Z')],
  });
  assert.equal(result.value, 'ILS');
  assert.equal(result.conflict?.manualValue, 'USD');
});
