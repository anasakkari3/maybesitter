/**
 * Wall-clock bounds on `validateDecomposition`. Run by `npm run test:perf`,
 * deliberately not by `npm test`.
 *
 * Moved from tests/decomposition/validatorViolations.test.ts by #380, following
 * the shape UC-0.3 (#136) used for tests/perf/safetyGateBound.perf.test.ts: the
 * structural half of each defect stays in the main suite, the timing half lives
 * here.
 *
 * **Why these two could not be converted into counted assertions.** Most of the
 * wall-clock budgets #380 removed were replaceable, because the work they
 * bounded was work done *on the caller's data* — a span compared, a node read —
 * and data the test builds can count its own reads. These two are not. Both
 * defects waste time inside `validateDecomposition` walking its own internal
 * index arrays:
 *
 *  - the cycle detector's `lastIndexOf` over a private `path` array of ids;
 *  - the overlap pass iterating step indices that carry no span at all.
 *
 * Neither touches anything the caller supplied while it wastes the time, and
 * neither changes the verdict — the same violations come back either way. So
 * there is no operation to count and no output to check, and a clock is the only
 * instrument left. Put a clock where a clock is expected.
 *
 * Run this on an idle machine. Under CPU contention these will report the
 * machine, which is exactly why they are not in the gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { DecompositionStepProposal } from '../../src/contracts/v1/decompositionContracts.ts';
import { validateDecomposition } from '../../lib/decomposition/engine/validator.ts';

const SOURCE = 'Book the venue and send the invitations.';

function step(overrides: Partial<DecompositionStepProposal> = {}): DecompositionStepProposal {
  return {
    stepId: 's1',
    title: 'Book the venue',
    sourceSpans: [{ start: 0, end: 14, text: 'Book the venue' }],
    inferred: false,
    dependsOn: [],
    statedTiming: null,
    statedOwner: null,
    ...overrides,
  };
}

/** `size` span-less steps whose dependency edges are `edgeTo(index)`. */
function spanlessSteps(
  size: number,
  edgeTo: (index: number) => string,
): DecompositionStepProposal[] {
  return Array.from({ length: size }, (_unused, index) => step({
    stepId: `s${index}`,
    title: 'x',
    sourceSpans: [],
    inferred: true,
    dependsOn: [{ dependsOnStepId: edgeTo(index), kind: 'temporal' }],
  }));
}

test('a deep back-edge graph is checked without stalling', () => {
  // `lastIndexOf` made "where does the cycle start?" O(depth of the gray path),
  // and a graph whose traversal goes deep before it closes turned that into a
  // stall. The `onPath` map makes it O(1). Same verdict either way, so only the
  // clock can tell them apart.
  //
  // **The fixture is a chain, and that is the whole test.** It used to be
  // `index === 0 ? s(size - 1) : 's0'` — 39,998 leaves pointing at the root and
  // a two-node cycle beside them — under the name "a deep back-edge graph". That
  // graph is not deep: the traversal's gray path never exceeds two entries, so
  // `lastIndexOf` over it is O(1) and the defect this test names could not fail
  // it. #380 measured that directly: reintroducing `lastIndexOf` left the test
  // green at 290 ms against its own 1,500 ms bound.
  //
  // A chain closed by one back edge from its last member drives the path to full
  // depth, which is the shape the defect needs.
  const size = 40000;
  const chain = spanlessSteps(size, (index) => `s${(index + 1) % size}`);
  const started = Date.now();
  validateDecomposition({ sourceText: SOURCE, steps: chain });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);
});

test('a proposal of span-less steps costs nothing to check for overlap', () => {
  // Collapsing overlap to one finding per step pair introduced a regression:
  // the pair walk covered every step, so 40,000 steps that claim no source at
  // all cost a second in a loop that could never find anything. Only steps
  // holding a usable span can collide.
  const size = 40000;
  const spanless = spanlessSteps(size, (index) => (index === 0 ? `s${size - 1}` : 's0'));
  const started = Date.now();
  validateDecomposition({ sourceText: SOURCE, steps: spanless });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `took ${elapsed} ms`);
});
