/**
 * Telling a blocked verification run apart from a passing one.
 *
 * `probesAreClean` treats both SKIPPED statuses as clean, which is right — a
 * pipeline with no credentials must stay green — and useless for reading the
 * outcome, because a fully blocked run then exits 0 exactly like a run that
 * proved something. Until now the only discriminator was padded text on
 * stdout.
 *
 * `probeReport` makes the distinction explicit without redefining what clean
 * means: the exit code still says "clean", and `outcome` says whether anything
 * was actually verified. These tests pin both halves, including that the exit
 * semantics did *not* move.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  probeOutcome,
  probeReport,
  probesAreClean,
  type ProbeResult,
  type ProbeStatus,
} from '../../lib/verification/liveProviderVerification.ts';

const AT = '2026-09-19T12:00:00.000Z';

function result(status: ProbeStatus, over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    provider: 'google',
    operation: 'gmail.history.list',
    status,
    contractValidated: status === 'PASS',
    latencyMs: null,
    recordCount: null,
    failureCategory: null,
    detail: null,
    at: AT,
    ...over,
  };
}

test('every status maps to exactly one of pass, blocked, failed', () => {
  const statuses: readonly ProbeStatus[] = [
    'PASS',
    'SKIPPED_MISSING_CREDENTIALS',
    'SKIPPED_UNSUPPORTED_LIVE_PROBE',
    'AUTH_FAILED',
    'SCOPE_INSUFFICIENT',
    'PROVIDER_ERROR',
    'CONTRACT_MISMATCH',
  ];
  const mapped = statuses.map((status) => [status, probeOutcome(result(status))] as const);

  assert.deepEqual(mapped, [
    ['PASS', 'pass'],
    // A skip is neither a success nor a failure. Naming it `blocked` is the
    // whole point: it is the state the Gmail probe is in until the owner
    // supplies a credential.
    ['SKIPPED_MISSING_CREDENTIALS', 'blocked'],
    ['SKIPPED_UNSUPPORTED_LIVE_PROBE', 'blocked'],
    ['AUTH_FAILED', 'failed'],
    ['SCOPE_INSUFFICIENT', 'failed'],
    ['PROVIDER_ERROR', 'failed'],
    ['CONTRACT_MISMATCH', 'failed'],
  ]);
});

test('a fully blocked run is reported as blocked, never as a pass', async () => {
  const results = [result('SKIPPED_MISSING_CREDENTIALS'), result('SKIPPED_UNSUPPORTED_LIVE_PROBE')];
  const report = probeReport(results, true);

  assert.equal(report.outcome, 'blocked');
  assert.deepEqual(report.summary, { total: 2, pass: 0, blocked: 2, failed: 0 });
  // The regression this exists to prevent: clean and verified are not the
  // same fact, and the exit code can only carry one of them.
  assert.equal(probesAreClean(results), true);
});

test('one failure makes the whole run failed even alongside a pass', () => {
  const report = probeReport([result('PASS'), result('CONTRACT_MISMATCH')], true);

  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.summary, { total: 2, pass: 1, blocked: 0, failed: 1 });
});

test('a run with a pass and a skip is a pass', () => {
  const report = probeReport([result('PASS'), result('SKIPPED_MISSING_CREDENTIALS')], true);

  assert.equal(report.outcome, 'pass');
  assert.deepEqual(report.summary, { total: 2, pass: 1, blocked: 1, failed: 0 });
});

test('an empty run is blocked, not vacuously passing', () => {
  const report = probeReport([], false);

  assert.equal(report.outcome, 'blocked');
  assert.equal(report.enabled, false);
  assert.deepEqual(report.summary, { total: 0, pass: 0, blocked: 0, failed: 0 });
});

test('the report is machine-readable and carries no provider content', () => {
  const report = probeReport(
    [result('PROVIDER_ERROR', { failureCategory: 'transport_failure', detail: 'redacted upstream', latencyMs: 12 })],
    true,
  );
  const round = JSON.parse(JSON.stringify(report));

  assert.equal(round.results[0].outcome, 'failed');
  assert.equal(round.results[0].failureCategory, 'transport_failure');
  // `ProbeResult` is content-free by construction — every field is a category
  // this repository produced or a count — which is why emitting the whole
  // array is safe.
  assert.deepEqual(Object.keys(round.results[0]).sort(), [
    'at', 'contractValidated', 'detail', 'failureCategory', 'latencyMs',
    'operation', 'outcome', 'provider', 'recordCount', 'status',
  ]);
});

test('the exit-code rule is unchanged by the new outcome field', () => {
  // Deliberately pinned: the point of the change was to make the distinction
  // visible, not to redefine clean underneath existing callers.
  assert.equal(probesAreClean([result('PASS')]), true);
  assert.equal(probesAreClean([result('SKIPPED_MISSING_CREDENTIALS')]), true);
  assert.equal(probesAreClean([result('SKIPPED_UNSUPPORTED_LIVE_PROBE')]), true);
  assert.equal(probesAreClean([result('AUTH_FAILED')]), false);
  assert.equal(probesAreClean([result('CONTRACT_MISMATCH')]), false);

  // And a blocked run is still clean while no longer being reported as a pass.
  const blocked = [result('SKIPPED_MISSING_CREDENTIALS')];
  assert.equal(probesAreClean(blocked), true);
  assert.equal(probeReport(blocked, true).outcome, 'blocked');
});
