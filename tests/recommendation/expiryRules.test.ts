/**
 * Expiry and invalidation (Sprint 08, issue #33).
 *
 * This file carries the acceptance criterion **"stale recommendations are
 * rejected"**, and the point of the section is that staleness is a *rule a
 * checker evaluates*, not a convention a caller is trusted to follow.
 *
 * Four things are being defended, in rough order of how quietly they fail:
 *
 *  1. **Unverifiable is stale.** A node the caller supplies no current
 *     fingerprint for fails closed. Every test written against a *complete*
 *     fingerprint map passes under either default, so the wrong default is
 *     invisible to a normal suite — and it is wrong in the worst direction: the
 *     freshness check would get more confident as the caller lost track of more
 *     sources. The prototype cases below are the sharp edge of this: a node
 *     named `toString` reads a function off `Object.prototype` from a plain
 *     record lookup, so a `!== undefined` guard silently answers "unchanged".
 *  2. **The state moving underneath is the real invalidator**; wall-clock expiry
 *     is the backstop. `SOURCE_CHANGED` and `SOURCE_REMOVED` are checked
 *     independently of the validity window, because a malformed `expiresAt` says
 *     nothing about whether a commitment was completed.
 *  3. **Report, never throw.** Every malformed instant this taxonomy names comes
 *     back as a finding. `planningContracts` records three sprint-07 defects of
 *     exactly this shape, each a helper raising several frames below the entry
 *     point, each invisible to a typed caller and immediate at the untyped
 *     boundary the module existed to guard.
 *  4. **No ambient clock.** Asserted structurally by scanning the contract
 *     source, not just behaviourally: a behavioural test can only show that the
 *     clock reads the module *happens* to make did not change the answer during
 *     the test run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RECOMMENDATION_TTL_MINUTES,
  RECOMMENDATION_CONTRACT_VERSION,
  RECOMMENDATION_SCHEMA_VERSION,
  STALENESS_REASON_CODES,
  bandForConfidence,
  evaluateRecommendationStaleness,
} from '../../src/contracts/v1/recommendationContracts.ts';
import type {
  EvidenceNode,
  Instant,
  ObservedEvidence,
  OfferedRecommendation,
  Recommendation,
  StalenessReason,
  StalenessVerdict,
  WithheldRecommendation,
} from '../../src/contracts/v1/recommendationContracts.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');

const BASIS = '2026-08-19T10:00:00.000Z';
const EXPIRES = '2026-08-19T11:00:00.000Z';

/* ── builders ─────────────────────────────────────────────────────── */

function observed(nodeId: string, fingerprint = `fp-${nodeId}`): ObservedEvidence {
  return {
    kind: 'observed',
    nodeId,
    source: { kind: 'commitment', commitmentId: 'c1', field: 'status' },
    claim: { kind: 'category', value: 'status_open' },
    observedAt: '2026-08-19T09:00:00.000Z',
    valueFingerprint: fingerprint,
  };
}

function derived(nodeId: string, parents: readonly [string, ...string[]]): EvidenceNode {
  return { kind: 'derived', nodeId, rule: 'ELIGIBLE_FROM_STATUS', claim: { kind: 'flag', value: true }, derivedFrom: parents };
}

function recommendation(
  nodes: readonly EvidenceNode[],
  validity: { basisAt: Instant; expiresAt: Instant } = { basisAt: BASIS, expiresAt: EXPIRES },
): OfferedRecommendation {
  const supportNode = nodes.length > 0 ? nodes[0].nodeId : 'n1';
  return {
    version: RECOMMENDATION_CONTRACT_VERSION,
    schema: RECOMMENDATION_SCHEMA_VERSION,
    recommendationId: 'rec-1',
    scopeId: 'scope-1',
    validity,
    evidence: { nodes },
    inputDigest: 'digest-1',
    outcome: 'offered',
    options: {
      kind: 'only_candidate',
      option: {
        optionIndex: 0,
        action: { kind: 'do_now', commitmentId: 'c1' },
        support: [{ code: 'OVERDUE', supportedBy: [supportNode], detail: 'the stated deadline has passed' }],
        confidence: { value: 0.8, band: bandForConfidence(0.8) as 'high', basis: [supportNode] },
      },
      attested: [supportNode],
    },
  };
}

function fingerprintsFor(nodes: readonly EvidenceNode[]): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const node of nodes) if (node.kind === 'observed') map[node.nodeId] = node.valueFingerprint;
  return map;
}

function reasonsOf(verdict: StalenessVerdict): readonly StalenessReason[] {
  return verdict.fresh ? [] : verdict.reasons;
}

function codesOf(verdict: StalenessVerdict): readonly string[] {
  return reasonsOf(verdict).map((reason) => reason.code);
}

/* ── the validity window ──────────────────────────────────────────── */

test('expiry: fresh strictly inside the window, at the lower bound, and one millisecond before the upper', () => {
  const nodes = [observed('n1')];
  const rec = recommendation(nodes);
  const current = fingerprintsFor(nodes);
  for (const now of [BASIS, '2026-08-19T10:30:00.000Z', '2026-08-19T10:59:59.999Z']) {
    const verdict = evaluateRecommendationStaleness({ recommendation: rec, now, currentFingerprints: current });
    assert.equal(verdict.fresh, true, `${now} must be fresh`);
    assert.equal('reasons' in verdict, false, 'a fresh verdict carries no reasons');
  }
});

test('expiry: the upper bound is exclusive, so the expiry instant itself is stale', () => {
  // Inclusive-vs-exclusive at the boundary surfaces only on a tick that lands on
  // a round instant, which is most of them.
  const nodes = [observed('n1')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: EXPIRES,
    currentFingerprints: fingerprintsFor(nodes),
  });
  assert.equal(verdict.fresh, false);
  assert.deepEqual(codesOf(verdict).slice(), ['EXPIRED']);
});

test('expiry: an instant after the window is stale', () => {
  const nodes = [observed('n1')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: '2026-08-19T11:00:00.001Z',
    currentFingerprints: fingerprintsFor(nodes),
  });
  assert.deepEqual(codesOf(verdict).slice(), ['EXPIRED']);
});

test('expiry: an instant before the basis is stale, not fresh', () => {
  // A replay or a clock defect. Answering "still good" to a question about a
  // time the run had not yet seen is the wrong direction to be lenient in.
  const nodes = [observed('n1')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: '2026-08-19T09:59:59.999Z',
    currentFingerprints: fingerprintsFor(nodes),
  });
  assert.deepEqual(codesOf(verdict).slice(), ['NOT_YET_VALID']);
});

test('expiry: a window that ends at or before it begins is reported as built broken, not as aged out', () => {
  // "It aged out" and "it was built broken" send a reader to different places —
  // TTL policy versus a construction defect.
  const nodes = [observed('n1')];
  for (const expiresAt of [BASIS, '2026-08-19T09:00:00.000Z']) {
    const verdict = evaluateRecommendationStaleness({
      recommendation: recommendation(nodes, { basisAt: BASIS, expiresAt }),
      now: '2026-08-19T10:30:00.000Z',
      currentFingerprints: fingerprintsFor(nodes),
    });
    assert.ok(codesOf(verdict).includes('EXPIRY_NOT_AFTER_BASIS'), `${expiresAt} must report the broken window`);
    assert.equal(verdict.fresh, false);
  }
});

/* ── malformed instants: report, never throw ──────────────────────── */

test('expiry: a malformed instant is reported against the field it came from', () => {
  const nodes = [observed('n1')];
  const cases: readonly (readonly [string, { basisAt: string; expiresAt: string }, string])[] = [
    ['not-a-date', { basisAt: BASIS, expiresAt: EXPIRES }, 'now'],
    ['2026-08-19T10:30:00.000Z', { basisAt: 'nope', expiresAt: EXPIRES }, 'basisAt'],
    ['2026-08-19T10:30:00.000Z', { basisAt: BASIS, expiresAt: '' }, 'expiresAt'],
  ];
  for (const [now, validity, field] of cases) {
    const verdict = evaluateRecommendationStaleness({
      recommendation: recommendation(nodes, validity),
      now,
      currentFingerprints: fingerprintsFor(nodes),
    });
    assert.equal(verdict.fresh, false, `${field} must not resolve fresh`);
    const invalid = reasonsOf(verdict).filter((reason) => reason.code === 'INVALID_INSTANT');
    assert.deepEqual(invalid.map((reason) => reason.field), [field]);
  }
});

test('expiry: findings that borrow a bound from a malformed instant are suppressed', () => {
  // The suppression rule, matching `planningContracts`: only findings that
  // borrow a bound from something already reported malformed are withheld.
  // EXPIRED and NOT_YET_VALID compare against the broken field, so they cannot
  // be computed; nothing else here borrows from it.
  const nodes = [observed('n1')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes, { basisAt: 'nope', expiresAt: 'also-nope' }),
    now: '2026-08-19T10:30:00.000Z',
    currentFingerprints: fingerprintsFor(nodes),
  });
  const codes = codesOf(verdict);
  assert.deepEqual(codes.slice(), ['INVALID_INSTANT', 'INVALID_INSTANT']);
  assert.equal(codes.includes('EXPIRED'), false);
  assert.equal(codes.includes('NOT_YET_VALID'), false);
  assert.equal(codes.includes('EXPIRY_NOT_AFTER_BASIS'), false);
});

test('expiry: the fingerprint pass runs even when the validity window is malformed', () => {
  // The two borrow nothing from each other. Suppressing the second would hide a
  // real invalidation behind a formatting bug.
  const nodes = [observed('n1')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes, { basisAt: 'nope', expiresAt: 'also-nope' }),
    now: 'nope-either',
    currentFingerprints: { n1: 'changed' },
  });
  assert.ok(codesOf(verdict).includes('SOURCE_CHANGED'));
});

test('expiry: no input shape makes the checker throw', () => {
  const nodes = [observed('n1'), derived('d1', ['n1'])];
  const hostile: readonly (readonly [string, { basisAt: string; expiresAt: string }])[] = [
    ['', { basisAt: '', expiresAt: '' }],
    ['   ', { basisAt: '   ', expiresAt: '   ' }],
    ['2026-13-45T99:99:99Z', { basisAt: 'Invalid Date', expiresAt: 'NaN' }],
    ['0000-00-00', { basisAt: '2026-08-19', expiresAt: '2026-08-19' }],
  ];
  for (const [now, validity] of hostile) {
    assert.doesNotThrow(() =>
      evaluateRecommendationStaleness({
        recommendation: recommendation(nodes, validity),
        now,
        currentFingerprints: {},
      }),
    );
  }
});

/* ── instants compare numerically, never lexicographically ────────── */

test('expiry: two spellings of one instant are the same instant', () => {
  // Lexicographic ordering of ISO-8601 is sound only for identically formatted
  // strings. `2026-08-19T11:00:00.000Z` and `2026-08-19T11:00:00+00:00` denote
  // the same moment and compare unequal as text, so a string comparison would
  // expire a recommendation early or late depending on which producer wrote the
  // field. The pair below is chosen so a `<` comparison gives the wrong answer.
  assert.ok('2026-08-19T11:00:00+00:00' < '2026-08-19T11:00:00.000Z', 'the fixture must discriminate the two orders');
  const nodes = [observed('n1')];
  const rec = recommendation(nodes, { basisAt: BASIS, expiresAt: '2026-08-19T11:00:00+00:00' });
  const current = fingerprintsFor(nodes);

  assert.equal(
    evaluateRecommendationStaleness({ recommendation: rec, now: '2026-08-19T10:59:59.999Z', currentFingerprints: current }).fresh,
    true,
  );
  assert.deepEqual(
    codesOf(evaluateRecommendationStaleness({ recommendation: rec, now: '2026-08-19T11:00:00.000Z', currentFingerprints: current })).slice(),
    ['EXPIRED'],
  );
});

/* ── invalidation by the state moving ─────────────────────────────── */

test('invalidation: a changed source fingerprint is stale inside the window', () => {
  const nodes = [observed('n1'), observed('n2')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: '2026-08-19T10:30:00.000Z',
    currentFingerprints: { n1: 'fp-n1', n2: 'something-else' },
  });
  assert.equal(verdict.fresh, false);
  assert.deepEqual(reasonsOf(verdict).map((reason) => `${reason.nodeId}:${reason.code}`).slice(), ['n2:SOURCE_CHANGED']);
});

test('invalidation: a removed source is distinguished from a changed one', () => {
  const nodes = [observed('n1')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: '2026-08-19T10:30:00.000Z',
    currentFingerprints: { n1: null },
  });
  assert.deepEqual(codesOf(verdict).slice(), ['SOURCE_REMOVED']);
});

test('invalidation: only observations are re-verified', () => {
  // A derived node has no source to re-read. Requiring a fingerprint for it
  // would push implementations to fabricate one for a value nothing can check.
  const nodes = [observed('n1'), derived('d1', ['n1']), derived('d2', ['d1'])];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: '2026-08-19T10:30:00.000Z',
    currentFingerprints: { n1: 'fp-n1' },
  });
  assert.equal(verdict.fresh, true, 'derived nodes must not demand fingerprints');
});

/* ── fail closed ──────────────────────────────────────────────────── */

test('invalidation: a node with no supplied fingerprint is stale, not fresh', () => {
  // The single most important line in this section. The opposite default makes
  // the check pass most confidently exactly when the caller has lost track of a
  // source, and every test written against a complete map still passes.
  const nodes = [observed('n1'), observed('n2')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: '2026-08-19T10:30:00.000Z',
    currentFingerprints: { n1: 'fp-n1' },
  });
  assert.equal(verdict.fresh, false);
  assert.deepEqual(reasonsOf(verdict).map((reason) => `${reason.nodeId}:${reason.code}`).slice(), ['n2:SOURCE_UNVERIFIABLE']);
});

test('invalidation: an empty fingerprint map makes every observation unverifiable', () => {
  const nodes = [observed('n1'), observed('n2'), derived('d1', ['n1'])];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: '2026-08-19T10:30:00.000Z',
    currentFingerprints: {},
  });
  assert.deepEqual(codesOf(verdict).slice(), ['SOURCE_UNVERIFIABLE', 'SOURCE_UNVERIFIABLE']);
});

test('invalidation: an inherited property is not a supplied fingerprint', () => {
  // A node named `toString` resolves to a function on `Object.prototype` from a
  // plain record lookup. A `!== undefined` guard would read that as "supplied",
  // then compare a function to a string, report SOURCE_CHANGED for the wrong
  // reason — and for `valueOf`-shaped cases where the comparison happened to
  // hold, report fresh. Membership is tested with `hasOwnProperty`.
  const nodes = [observed('toString'), observed('constructor'), observed('valueOf')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: '2026-08-19T10:30:00.000Z',
    currentFingerprints: {},
  });
  assert.deepEqual(
    reasonsOf(verdict).map((reason) => `${reason.nodeId}:${reason.code}`).slice(),
    ['toString:SOURCE_UNVERIFIABLE', 'constructor:SOURCE_UNVERIFIABLE', 'valueOf:SOURCE_UNVERIFIABLE'],
  );
});

test('invalidation: a prototype-free map behaves identically to a plain object', () => {
  const nodes = [observed('n1')];
  const bare = Object.create(null) as Record<string, string | null>;
  bare.n1 = 'fp-n1';
  assert.equal(
    evaluateRecommendationStaleness({
      recommendation: recommendation(nodes),
      now: '2026-08-19T10:30:00.000Z',
      currentFingerprints: bare,
    }).fresh,
    true,
  );
});

test('invalidation: a node literally named __proto__ is still verified', () => {
  const nodes = [observed('__proto__')];
  const map = Object.create(null) as Record<string, string | null>;
  Object.defineProperty(map, '__proto__', { value: 'fp-__proto__', enumerable: true, configurable: true, writable: true });
  assert.equal(
    evaluateRecommendationStaleness({
      recommendation: recommendation(nodes),
      now: '2026-08-19T10:30:00.000Z',
      currentFingerprints: map,
    }).fresh,
    true,
  );
  const missing = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: '2026-08-19T10:30:00.000Z',
    currentFingerprints: Object.create(null) as Record<string, string | null>,
  });
  assert.deepEqual(codesOf(missing).slice(), ['SOURCE_UNVERIFIABLE']);
});

/* ── withheld recommendations expire too ──────────────────────────── */

test('expiry: a withheld verdict goes stale on the same terms as an offer', () => {
  // "There is nothing for you to do" is a claim about trusted state with a shelf
  // life. A withheld verdict that could not go stale would be cached past the
  // moment the user added a commitment.
  const nodes = [
    observed('zero'),
  ];
  const withheld: WithheldRecommendation = {
    version: RECOMMENDATION_CONTRACT_VERSION,
    schema: RECOMMENDATION_SCHEMA_VERSION,
    recommendationId: 'rec-2',
    scopeId: 'scope-1',
    validity: { basisAt: BASIS, expiresAt: EXPIRES },
    evidence: { nodes },
    inputDigest: 'digest-2',
    outcome: 'withheld',
    reasons: [{ code: 'NO_ELIGIBLE_CANDIDATE', supportedBy: ['zero'], detail: 'the scope holds no open commitment' }],
  };
  assert.equal(
    evaluateRecommendationStaleness({ recommendation: withheld, now: '2026-08-19T10:30:00.000Z', currentFingerprints: { zero: 'fp-zero' } }).fresh,
    true,
  );
  assert.deepEqual(
    codesOf(evaluateRecommendationStaleness({ recommendation: withheld, now: '2026-08-19T10:30:00.000Z', currentFingerprints: { zero: 'a-commitment-appeared' } })).slice(),
    ['SOURCE_CHANGED'],
  );
  assert.deepEqual(
    codesOf(evaluateRecommendationStaleness({ recommendation: withheld, now: EXPIRES, currentFingerprints: { zero: 'fp-zero' } })).slice(),
    ['EXPIRED'],
  );
});

/* ── verdict shape and determinism ────────────────────────────────── */

test('expiry: any reason at all means not fresh, and there is no soft staleness', () => {
  // A verdict a caller can weigh is a verdict a caller can overrule. The
  // acceptance criterion is rejection, so there is no severity field to weigh.
  const nodes = [observed('n1')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes),
    now: EXPIRES,
    currentFingerprints: fingerprintsFor(nodes),
  });
  assert.equal(verdict.fresh, false);
  const reasons = reasonsOf(verdict);
  assert.ok(reasons.length > 0);
  for (const reason of reasons) {
    assert.equal('severity' in reason, false, 'a staleness reason carries no weight to overrule it with');
    assert.ok(STALENESS_REASON_CODES.includes(reason.code), `${reason.code} is outside the taxonomy`);
  }
});

test('expiry: reasons come back in a fixed order — window findings, then nodes in graph order', () => {
  // An inverted window evaluated inside it is the one input that fires all three
  // window findings at once, which is what makes their relative order testable
  // rather than assumed. It took a wrong expectation here to notice that a
  // *degenerate* window (basis === expiry) evaluated before the basis fires only
  // two — EXPIRED genuinely does not hold there, and asserting it would have
  // pinned a bug rather than the behaviour.
  const nodes = [observed('z'), observed('a'), observed('m')];
  const input = {
    recommendation: recommendation(nodes, { basisAt: BASIS, expiresAt: '2026-08-19T09:00:00.000Z' }),
    now: '2026-08-19T09:30:00.000Z',
    currentFingerprints: { a: null },
  };
  const first = evaluateRecommendationStaleness(input);
  const second = evaluateRecommendationStaleness(input);
  assert.deepEqual(reasonsOf(first).slice(), reasonsOf(second).slice());
  assert.deepEqual(
    reasonsOf(first).map((reason) => `${reason.nodeId ?? '-'}:${reason.code}`).slice(),
    ['-:EXPIRY_NOT_AFTER_BASIS', '-:NOT_YET_VALID', '-:EXPIRED', 'z:SOURCE_UNVERIFIABLE', 'a:SOURCE_REMOVED', 'm:SOURCE_UNVERIFIABLE'],
  );
});

test('expiry: only INVALID_INSTANT carries a field name', () => {
  const nodes = [observed('n1')];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes, { basisAt: 'bad', expiresAt: EXPIRES }),
    now: EXPIRES,
    currentFingerprints: { n1: 'changed' },
  });
  for (const reason of reasonsOf(verdict)) {
    if (reason.code === 'INVALID_INSTANT') assert.notEqual(reason.field, null);
    else assert.equal(reason.field, null, `${reason.code} must not claim a field`);
  }
});

test('leak: no staleness detail carries a caller-chosen identifier or a raw instant', () => {
  const hostile = 'call-dr.cohen-about-the-biopsy';
  const nodes = [observed(hostile), observed(`${hostile}-2`)];
  const verdict = evaluateRecommendationStaleness({
    recommendation: recommendation(nodes, { basisAt: hostile, expiresAt: hostile }),
    now: hostile,
    currentFingerprints: { [`${hostile}-2`]: 'changed' },
  });
  const reasons = reasonsOf(verdict);
  assert.ok(reasons.length >= 4, 'the fixture must produce a spread of findings');
  for (const reason of reasons) {
    assert.equal(reason.detail.includes(hostile), false, `${reason.code} leaked an id into its detail: ${reason.detail}`);
  }
});

/* ── no ambient clock ─────────────────────────────────────────────── */

test('clock: the contract reads no clock and no entropy source', () => {
  // Structural, not behavioural: a behavioural test can only show that whatever
  // clock reads the module makes did not change the answer during this run.
  // Determinism is the acceptance criterion and one `Date.now()` anywhere in
  // this file would break it in a way no fixture would reliably catch.
  const source = readFileSync(join(repoRoot, 'src', 'contracts', 'v1', 'recommendationContracts.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(code.includes('evaluateRecommendationStaleness'), 'the scan must actually see the code');

  for (const forbidden of [/\bDate\s*\.\s*now\b/, /\bnew\s+Date\s*\(\s*\)/, /\bMath\s*\.\s*random\b/, /\brandomUUID\b/, /\bperformance\s*\.\s*now\b/]) {
    assert.equal(forbidden.test(code), false, `the contract must not use ${forbidden}`);
  }
  // `Date.parse` is permitted and is the only Date use: it is a pure function of
  // its argument, with no reference to the current time.
  assert.ok(/\bDate\s*\.\s*parse\b/.test(code), 'the scan must see the one permitted Date use');
});

test('clock: the same inputs give the same verdict on repeated evaluation', () => {
  const nodes = [observed('n1'), observed('n2')];
  const input = {
    recommendation: recommendation(nodes),
    now: '2026-08-19T10:30:00.000Z',
    currentFingerprints: { n1: 'fp-n1', n2: 'moved' },
  };
  const runs: StalenessVerdict[] = [];
  for (let index = 0; index < 50; index += 1) runs.push(evaluateRecommendationStaleness(input));
  for (const run of runs) assert.deepEqual(run, runs[0]);
});

test('clock: the default TTL is a constant, not something the module applies to a clock', () => {
  // A default a caller may use, never an expiry this module computes. Nothing
  // here turns minutes into an instant, which the clock scan above enforces.
  assert.equal(typeof DEFAULT_RECOMMENDATION_TTL_MINUTES, 'number');
  assert.ok(Number.isFinite(DEFAULT_RECOMMENDATION_TTL_MINUTES) && DEFAULT_RECOMMENDATION_TTL_MINUTES > 0);
  const nodes = [observed('n1')];
  // A recommendation whose window is *shorter* than the default is honoured as
  // written: the default does not widen anything.
  const shortWindow = recommendation(nodes, { basisAt: BASIS, expiresAt: '2026-08-19T10:05:00.000Z' });
  assert.deepEqual(
    codesOf(evaluateRecommendationStaleness({
      recommendation: shortWindow as Recommendation,
      now: '2026-08-19T10:06:00.000Z',
      currentFingerprints: fingerprintsFor(nodes),
    })).slice(),
    ['EXPIRED'],
  );
});
