/**
 * Wall-clock bound on `checkEvidenceGraph`'s cycle detection. Run by
 * `npm run test:perf`, deliberately not by `npm test`.
 *
 * Moved from tests/recommendation/evidenceGraph.test.ts by #380, following the
 * shape UC-0.3 (#136) used for tests/perf/safetyGateBound.perf.test.ts.
 *
 * **Why this one could not be converted into a counted assertion.** The
 * detector this guards — Tarjan, one linear pass — replaced an O(V·(V+E)) one
 * that reached the same verdict. Both return `[]` for an acyclic graph and the
 * same members for a cyclic one, and the quadratic one did its wasted work on a
 * private adjacency array built once from the caller's nodes, so the nodes
 * themselves are read the same number of times either way. There is no output
 * to compare and no read to count; the difference is time and nothing else.
 *
 * The verdicts stay in tests/recommendation/evidenceGraph.test.ts and run on
 * every `npm test` — every member of a cycle reported, deep chains resolved
 * without overflowing the stack, self-edges kept distinct from cycles. What
 * moved here is only the claim about how long it takes.
 *
 * Run this on an idle machine. Under CPU contention it reports the machine,
 * which is why it is not in the gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkEvidenceGraph } from '../../src/contracts/v1/recommendationContracts.ts';
import type { EvidenceNode } from '../../src/contracts/v1/recommendationContracts.ts';

test('graph: cycle detection stays linear at scale', () => {
  // The previous detector was O(V·(V+E)) — 222ms at five thousand nodes — and
  // its backward-reachability pass was provably dead: after the forward guard
  // the node already reaches itself, so the intersection never excluded
  // anything. Tarjan replaces both. The bound here is loose on purpose; it is
  // guarding an order of growth, not a machine.
  const nodes: EvidenceNode[] = [{
    kind: 'observed',
    nodeId: 'root',
    source: { kind: 'commitment', commitmentId: 'c1', field: 'due_at' },
    claim: { kind: 'category', value: 'overdue' },
    observedAt: '2026-08-19T09:00:00.000Z',
    valueFingerprint: 'fp-root',
  }];
  for (let index = 1; index < 20000; index += 1) {
    nodes.push({
      kind: 'derived',
      nodeId: `n${index}`,
      rule: 'OVERDUE_FROM_DUE_AT',
      claim: { kind: 'flag', value: true },
      derivedFrom: ['root'],
    });
  }
  const started = process.hrtime.bigint();
  assert.deepEqual(checkEvidenceGraph({ nodes }).slice(), []);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 2000, `checkEvidenceGraph took ${elapsedMs.toFixed(0)}ms on 20k nodes`);
});
