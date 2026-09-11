/**
 * Wall-clock bound on the safety gate's input scanning. Run by
 * `npm run test:perf`, deliberately not by `npm test`: a timing assertion fails
 * under CPU load (two suites in parallel, a build in the background), and a red
 * that means "the machine was busy" teaches people to ignore red.
 *
 * The structural half of the same defect — an over-length or over-count span is
 * excluded from every later scan, and the admitted-span counts this test pins —
 * stays in tests/safety/validators.test.ts, where it runs on every `npm test`.
 * Run this on an idle machine.
 *
 * Moved from tests/safety/validators.test.ts ("input scanning does not grow with
 * input past the bound") by UC-0.3 (#136).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SAFETY_LIMITS } from '../../src/contracts/v1/safetyContracts.ts';
import { evaluateSafetyGate } from '../../lib/safety/gateway.ts';
import { scannableInputs } from '../../lib/safety/inputs.ts';
import { cleanCandidate, cleanRequest } from '../safety/candidates.ts';

/**
 * A bound is a bound on **work**, not a bound on findings.
 *
 * `every key of SAFETY_LIMITS is enforced` asserted only that a finding naming
 * each limit was emitted, and both input limits passed it while bounding
 * nothing: the pre validator stopped its own scan and the gateway then ran the
 * post validator unconditionally over the same unbounded list. 40 spans of 200K
 * characters cost 19 seconds on a request already decided to block; 200 spans
 * cost 78.
 *
 * This asserts the property the count check could not see — that the work does
 * not grow with input past the bound.
 */
test('input scanning does not grow with input past the bound', () => {
  const candidate = cleanCandidate({
    // One below `maxSegmentChars`, so every segment is actually scanned. At or
    // above it the segment is skipped and this test measures nothing.
    segments: Array.from({ length: SAFETY_LIMITS.maxSegments }, () => ({
      role: 'body' as const,
      text: 'x'.repeat(SAFETY_LIMITS.maxSegmentChars - 1),
    })),
  });
  // One below `maxUntrustedInputChars`, for the same reason as the segments
  // above and **spelled the same way**, from the constant rather than as a
  // number. It was a literal 200,000 against a bound of 8,000, so every span was
  // dropped by the character check and both timings below measured an empty
  // loop: 4 spans and 200 spans did identical work, which is exactly the shape
  // that makes a growth assertion pass.
  const spans = (count: number) =>
    cleanRequest({
      inputs: Array.from({ length: count }, (_unused, index) => ({
        inputId: `in-${index}`,
        origin: 'user_text' as const,
        sensitivity: 'sensitive' as const,
        declaredTrust: 'data' as const,
        text: 'y'.repeat(SAFETY_LIMITS.maxUntrustedInputChars - 1),
      })),
    });

  // The growth assertion is meaningless if nothing is admitted, and a timing
  // comparison cannot tell an empty loop from a fast one. Pin the work first.
  assert.equal(
    scannableInputs(spans(4)).length,
    4,
    'the small case admitted no spans, so the comparison below is between two empty loops',
  );
  assert.equal(
    scannableInputs(spans(200)).length,
    SAFETY_LIMITS.maxUntrustedInputs,
    'the large case is not clamped by the count bound, so this measures the wrong property',
  );

  const timed = (count: number): number => {
    const startedAt = process.hrtime.bigint();
    evaluateSafetyGate({ request: spans(count), candidate, auditId: 'a-1' });
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  };

  timed(4); // warm the JIT so the comparison is about the algorithm
  const small = timed(4);
  const large = timed(200);
  // 50x the input. Unbounded, this was ~200x the time and 78 seconds absolute.
  assert.ok(large < 2_000, `200 over-length spans took ${large.toFixed(0)}ms`);
  assert.ok(
    large < small * 8 + 200,
    `work grew from ${small.toFixed(0)}ms to ${large.toFixed(0)}ms across a 50x input; the bound is not bounding`,
  );
});
