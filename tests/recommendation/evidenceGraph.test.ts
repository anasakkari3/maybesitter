/**
 * The evidence graph (Sprint 08, issue #33).
 *
 * This file carries the acceptance criterion **"every claim traces to trusted
 * state"**, and it carries it as a *theorem* rather than as a list of examples.
 *
 * The contract's claim is structural: `derivedFrom` and `supportedBy` are
 * non-empty tuples, so a claim with no parents is unconstructible; and
 * `checkEvidenceGraph` rejects cycles and dangling references, so every ancestry
 * path in an accepted graph is finite and must terminate at an `observed` node.
 * A hand-built table of graphs tests the shapes its author thought of — Sprint
 * 07's recorded lesson, where a fuzzer found three disagreement shapes a 44-case
 * table had missed. So the central test here **generates** graphs and asserts
 * the implication directly: for every graph `checkEvidenceGraph` accepts,
 * `resolveEvidenceRoots` returns a non-empty set of observations for *every*
 * node. The generator is seeded, so a failure is reproducible from its seed.
 *
 * Two supporting concerns:
 *
 *  - **Cycle membership is asserted per node, not as a set of code names.** The
 *    exact defect Sprint 07's cross-track fuzz found in the planning cycle
 *    detector was a member reached through a cross edge going unreported while
 *    the code stayed in the reported set, contributed by the two members that
 *    were found. A set-level assertion sees perfect agreement there. Every test
 *    below compares `(nodeId, code)` pairs.
 *  - **No caller-chosen identifier reaches a human-readable string.** Sprint
 *    07's ruling, and the leak it was written for was real. Asserted by fuzzing
 *    with ids that are themselves sensitive sentences, over both checkers and
 *    every defect they can produce — a character-class filter would not help,
 *    because the problem is not the characters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_GRAPH_DEFECT_CODES,
  RECOMMENDATION_CONTRACT_VERSION,
  RECOMMENDATION_SCHEMA_VERSION,
  bandForConfidence,
  checkEvidenceGraph,
  checkRecommendation,
  resolveEvidenceRoots,
} from '../../src/contracts/v1/recommendationContracts.ts';
import type {
  DerivedEvidence,
  EvidenceGraph,
  EvidenceNode,
  ObservedEvidence,
  OfferedRecommendation,
  OptionSet,
  Recommendation,
  RecommendationDefect,
  WithheldRecommendation,
} from '../../src/contracts/v1/recommendationContracts.ts';

/* ── builders ─────────────────────────────────────────────────────── */

function observed(nodeId: string, overrides: Partial<ObservedEvidence> = {}): ObservedEvidence {
  return {
    kind: 'observed',
    nodeId,
    source: { kind: 'commitment', commitmentId: 'c1', field: 'due_at' },
    claim: { kind: 'category', value: 'overdue' },
    observedAt: '2026-08-19T09:00:00.000Z',
    valueFingerprint: `fp-${nodeId}`,
    ...overrides,
  };
}

function derived(nodeId: string, parents: readonly [string, ...string[]]): DerivedEvidence {
  return {
    kind: 'derived',
    nodeId,
    rule: 'OVERDUE_FROM_DUE_AT',
    claim: { kind: 'flag', value: true },
    derivedFrom: parents,
  };
}

function graph(...nodes: readonly EvidenceNode[]): EvidenceGraph {
  return { nodes };
}

function pairs(defects: readonly RecommendationDefect[]): readonly string[] {
  return defects.map((defect) => `${defect.nodeId ?? '-'}:${defect.code}`);
}

function codesOf(defects: readonly RecommendationDefect[]): readonly string[] {
  return defects.map((defect) => defect.code);
}

/* ── the defect taxonomy, one shape at a time ─────────────────────── */

test('graph: an empty graph and a graph of pure observations are clean', () => {
  assert.deepEqual(checkEvidenceGraph(graph()).slice(), []);
  assert.deepEqual(checkEvidenceGraph(graph(observed('a'), observed('b'))).slice(), []);
});

test('graph: a well-formed derivation chain is clean and resolves to its roots', () => {
  const g = graph(observed('a'), observed('b'), derived('d', ['a', 'b']), derived('e', ['d']));
  assert.deepEqual(checkEvidenceGraph(g).slice(), []);
  const roots = resolveEvidenceRoots(g, 'e');
  assert.notEqual(roots, null);
  assert.deepEqual((roots as readonly ObservedEvidence[]).map((node) => node.nodeId), ['a', 'b']);
});

test('graph: a blank node id is reported and does not also report as a duplicate', () => {
  // Suppression: the duplication between two blank ids is an artefact of the
  // blankness, and reporting both would tell a caller it has two problems.
  const g = graph(observed(''), observed('   '), observed('a'));
  assert.deepEqual(codesOf(checkEvidenceGraph(g)).slice(), ['BLANK_NODE_ID', 'BLANK_NODE_ID']);
});

test('graph: a repeated node id is reported against the later position', () => {
  const g = graph(observed('a'), observed('b'), observed('a'));
  const defects = checkEvidenceGraph(g);
  assert.deepEqual(pairs(defects).slice(), ['a:DUPLICATE_EVIDENCE_NODE']);
  assert.ok(defects[0].detail.includes('#2'), 'the finding must name the repeat by position');
  assert.ok(defects[0].detail.includes('#0'), 'and the position it repeats');
});

test('graph: a blank fingerprint is reported, because it can never differ from the next one', () => {
  const g = graph(observed('a', { valueFingerprint: '' }), observed('b', { valueFingerprint: '  ' }));
  assert.deepEqual(pairs(checkEvidenceGraph(g)).slice(), ['a:EMPTY_FINGERPRINT', 'b:EMPTY_FINGERPRINT']);
});

test('graph: a derived node is not fingerprint-checked', () => {
  // Only observations are re-verifiable; a derived node has no source of its own
  // to compare against, and demanding one would push implementations to
  // fabricate a fingerprint for a value nothing can re-read.
  assert.deepEqual(checkEvidenceGraph(graph(observed('a'), derived('d', ['a']))).slice(), []);
});

test('graph: an edge naming no node in this graph is reported per edge', () => {
  const g = graph(observed('a'), derived('d', ['a', 'ghost', 'other-ghost']));
  const defects = checkEvidenceGraph(g);
  assert.deepEqual(pairs(defects).slice(), ['d:UNKNOWN_EVIDENCE_NODE', 'd:UNKNOWN_EVIDENCE_NODE']);
  assert.ok(defects[0].detail.includes('edge #1'));
  assert.ok(defects[1].detail.includes('edge #2'));
});

test('graph: a self-edge is SELF_DERIVED_EVIDENCE and never also CYCLIC_EVIDENCE', () => {
  // One defect earns one code — the rule `decompositionContracts` set and
  // `planningContracts` repeated. A caller handed two rejections for one edge
  // cannot tell whether it has one problem or two.
  const g = graph(observed('a'), derived('d', ['d', 'a']));
  assert.deepEqual(pairs(checkEvidenceGraph(g)).slice(), ['d:SELF_DERIVED_EVIDENCE']);
});

test('graph: a self-edge reported once however many times it is repeated', () => {
  const g = graph(observed('a'), derived('d', ['d', 'd', 'a']));
  assert.deepEqual(pairs(checkEvidenceGraph(g)).slice(), ['d:SELF_DERIVED_EVIDENCE']);
});

test('graph: a node carrying both a self-edge and a real cycle earns both codes', () => {
  // Two distinct defects, not one told twice: removing the self-edge leaves the
  // cycle, and removing the cycle leaves the self-edge.
  const g = graph(derived('x', ['x', 'y']), derived('y', ['x']));
  const found = pairs(checkEvidenceGraph(g));
  assert.ok(found.includes('x:SELF_DERIVED_EVIDENCE'));
  assert.ok(found.includes('x:CYCLIC_EVIDENCE'));
  assert.ok(found.includes('y:CYCLIC_EVIDENCE'));
});

/* ── cycle membership, at (nodeId, code) granularity ──────────────── */

test('graph: every member of a cycle is reported, including one reached by a cross edge', () => {
  // This is the Sprint 07 shape. `d` reaches `b` through a cross edge and is not
  // itself on a cycle; a detector that reported whichever nodes its traversal
  // happened to close a loop through could easily miss `c` while leaving
  // CYCLIC_EVIDENCE in the reported *set*, contributed by `a` and `b`. A
  // set-level assertion would see perfect agreement. This one does not.
  const g = graph(derived('a', ['b']), derived('b', ['c']), derived('c', ['a']), derived('d', ['b']));
  const cyclic = checkEvidenceGraph(g)
    .filter((defect) => defect.code === 'CYCLIC_EVIDENCE')
    .map((defect) => defect.nodeId);
  assert.deepEqual(cyclic.slice().sort(), ['a', 'b', 'c']);
  assert.equal(cyclic.includes('d'), false, 'a node that merely points into a cycle is not on it');
});

test('graph: two disjoint cycles are both reported in full', () => {
  const g = graph(
    derived('a1', ['a2']),
    derived('a2', ['a1']),
    observed('root'),
    derived('b1', ['b2']),
    derived('b2', ['b3']),
    derived('b3', ['b1']),
  );
  const cyclic = checkEvidenceGraph(g)
    .filter((defect) => defect.code === 'CYCLIC_EVIDENCE')
    .map((defect) => defect.nodeId);
  assert.deepEqual(cyclic.slice().sort(), ['a1', 'a2', 'b1', 'b2', 'b3']);
});

test('graph: a dangling edge does not suppress a cycle among the edges that resolve', () => {
  // The suppression rule is "borrows a bound from something already reported
  // malformed", no wider. The cycle borrows nothing from the broken edge.
  const g = graph(derived('a', ['b', 'ghost']), derived('b', ['a']));
  const found = pairs(checkEvidenceGraph(g));
  assert.ok(found.includes('a:UNKNOWN_EVIDENCE_NODE'));
  assert.ok(found.includes('a:CYCLIC_EVIDENCE'));
  assert.ok(found.includes('b:CYCLIC_EVIDENCE'));
});

/* ── determinism ──────────────────────────────────────────────────── */

test('graph: findings are deterministic and ordered by input position', () => {
  const g = graph(observed('z', { valueFingerprint: '' }), observed('a', { valueFingerprint: '' }));
  const first = checkEvidenceGraph(g);
  const second = checkEvidenceGraph(g);
  assert.deepEqual(first.slice(), second.slice());
  // Node order, not id order. An id-ordered output would need a string
  // comparator, and the only two available would be a second copy of
  // `compareByCodePoint` or `localeCompare`, whose result moves with `LANG`.
  assert.deepEqual(pairs(first).slice(), ['z:EMPTY_FINGERPRINT', 'a:EMPTY_FINGERPRINT']);
});

/* ── resolveEvidenceRoots ─────────────────────────────────────────── */

test('graph: an observation resolves to itself', () => {
  const g = graph(observed('a'));
  assert.deepEqual((resolveEvidenceRoots(g, 'a') as readonly ObservedEvidence[]).map((n) => n.nodeId), ['a']);
});

test('graph: an unresolvable ancestry reports null rather than throwing', () => {
  // Returning null keeps this usable as the assertion in the property test
  // below. A version that threw would make the property testable only by
  // catching, and a caught throw is indistinguishable from a bug in the test.
  assert.equal(resolveEvidenceRoots(graph(observed('a')), 'missing'), null);
  assert.equal(resolveEvidenceRoots(graph(derived('d', ['ghost'])), 'd'), null);
  assert.equal(resolveEvidenceRoots(graph(derived('a', ['b']), derived('b', ['a'])), 'a'), null);
});

test('graph: roots are deduplicated and returned in node order', () => {
  const g = graph(observed('r1'), observed('r2'), derived('d1', ['r1', 'r2']), derived('d2', ['r1']), derived('top', ['d1', 'd2']));
  const roots = resolveEvidenceRoots(g, 'top') as readonly ObservedEvidence[];
  assert.deepEqual(roots.map((node) => node.nodeId), ['r1', 'r2']);
});

/* ── the theorem, by generated input ──────────────────────────────── */

/**
 * A seeded 32-bit LCG. Deterministic on purpose: `Math.random` would make a
 * failure unreproducible, and the whole value of generating inputs is that the
 * failing one can be replayed.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * The generator, rebuilt after a review measured what the first one actually
 * produced.
 *
 * The first version emitted only well-formed unique ids and only non-empty
 * parent lists, so it was **structurally incapable** of producing three of the
 * eight defect codes — including `UNSOURCED_DERIVATION`, the counter-example
 * that falsified the contract's central claim. Worse, 62% of the graphs it
 * accepted contained no `derived` node at all, so the property it was proving
 * held vacuously in the majority of its own iterations, and the `>2000 accepted`
 * floor was satisfied entirely by trivial cases.
 *
 * That is Sprint 07's lesson turned inside out. The recorded version is "where a
 * sprint's central claim is that two implementations agree, generate the
 * inputs". The corollary this cost: *a generator is only as strong as the
 * hardest case it can express*, and a count of iterations says nothing about
 * that. So the distribution is now asserted, not assumed — see the
 * `generator:` test below, which fails if the fuzz stops reaching a code or
 * stops building depth.
 *
 * Parents are drawn from *earlier* indices most of the time, which is what
 * actually builds depth: uniform selection over all ids produces wide, shallow
 * graphs and a cycle almost immediately.
 */
function generateGraph(random: () => number): EvidenceGraph {
  // Floor of three, not one: a one-node graph is almost always a lone
  // observation, and it lands in the *accepted* bucket, so a low floor inflates
  // the accepted count with cases that prove nothing.
  const size = 3 + Math.floor(random() * 10);
  const ids: string[] = [];
  for (let index = 0; index < size; index += 1) ids.push(`n${index}`);
  const nodes: EvidenceNode[] = [];

  for (let index = 0; index < size; index += 1) {
    const roll = random();

    // A node this contract version does not recognise.
    if (roll < 0.03) {
      nodes.push({ kind: 'inferred', nodeId: ids[index], claim: { kind: 'flag', value: true } } as unknown as EvidenceNode);
      continue;
    }
    // An unusable identifier: blank, whitespace, or not a string at all.
    if (roll < 0.06) {
      const bad = random() < 0.5 ? '' : random() < 0.5 ? '   ' : (index as unknown as string);
      nodes.push(observed(bad as string));
      continue;
    }
    // A repeated identifier.
    if (roll < 0.09 && index > 0) {
      nodes.push(observed(ids[Math.floor(random() * index)]));
      continue;
    }
    if (index === 0 || roll < 0.30) {
      nodes.push(observed(ids[index], random() < 0.08 ? { valueFingerprint: '' } : {}));
      continue;
    }
    // A derivation that names no parent at all — the BLOCKER 1 counter-example,
    // which the previous generator could not express.
    if (roll < 0.34) {
      nodes.push({
        kind: 'derived',
        nodeId: ids[index],
        rule: 'OVERDUE_FROM_DUE_AT',
        claim: { kind: 'flag', value: true },
        derivedFrom: [] as unknown as [string, ...string[]],
      });
      continue;
    }

    const parentCount = 1 + Math.floor(random() * 3);
    const parents: string[] = [];
    for (let edge = 0; edge < parentCount; edge += 1) {
      const pick = random();
      if (pick < 0.08) parents.push(`ghost${edge}`);
      else if (pick < 0.14) parents.push(ids[index]);
      else if (pick < 0.30) parents.push(ids[Math.floor(random() * size)]);
      // The depth-building branch: a strictly earlier node, and mostly the
      // immediately preceding one, which is what produces long chains.
      else parents.push(ids[Math.max(0, index - 1 - Math.floor(random() * 2))]);
    }
    nodes.push(derived(ids[index], parents as [string, ...string[]]));
  }
  return { nodes };
}

/** Longest derivation path from a node, for the distribution assertions. */
function derivationDepth(g: EvidenceGraph, nodeId: string): number {
  const byId = new Map<string, EvidenceNode>();
  for (const node of g.nodes) if (!byId.has(node.nodeId)) byId.set(node.nodeId, node);
  const memo = new Map<string, number>();
  const walk = (id: string, seen: Set<string>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (node === undefined || node.kind !== 'derived' || seen.has(id)) return 0;
    seen.add(id);
    let best = 0;
    for (const parent of node.derivedFrom) best = Math.max(best, 1 + walk(parent, seen));
    seen.delete(id);
    memo.set(id, best);
    return best;
  };
  return walk(nodeId, new Set<string>());
}

test('graph: every claim in an accepted graph traces to an observation', () => {
  const random = makeRandom(0x5eed08);
  let accepted = 0;
  let rejected = 0;

  for (let iteration = 0; iteration < 40000; iteration += 1) {
    const g = generateGraph(random);
    const defects = checkEvidenceGraph(g);
    if (defects.length > 0) {
      rejected += 1;
      continue;
    }
    accepted += 1;
    for (const node of g.nodes) {
      const roots = resolveEvidenceRoots(g, node.nodeId);
      assert.notEqual(roots, null, `accepted graph must resolve ${node.nodeId}`);
      const resolved = roots as readonly ObservedEvidence[];
      assert.ok(resolved.length > 0, 'a resolved claim must rest on at least one observation');
      for (const root of resolved) {
        assert.equal(root.kind, 'observed', 'a root must be an observation of trusted state');
      }
    }
  }

  // Both floors are absolute counts, and the iteration count was raised to keep
  // them met after the generator got harder — never the floors lowered to fit
  // the generator. Lowering an evidence threshold to match a weaker input set is
  // how a suite ends up reporting the strength it used to have.
  assert.ok(accepted > 2000, `too few accepted graphs to be meaningful: ${accepted}`);
  assert.ok(rejected > 2000, `too few rejected graphs to be meaningful: ${rejected}`);
});

test('generator: the fuzz reaches every defect code and actually builds depth', () => {
  // The assertion the first version of this file did not make, and the reason it
  // proved less than it claimed. A fuzzer that cannot express a defect reports a
  // clean result about it forever, and an iteration count hides that completely.
  const random = makeRandom(0x5eed08);
  const codesSeen = new Set<string>();
  let acceptedWithDerived = 0;
  let accepted = 0;
  let deepestAccepted = 0;

  for (let iteration = 0; iteration < 40000; iteration += 1) {
    const g = generateGraph(random);
    const defects = checkEvidenceGraph(g);
    for (const defect of defects) codesSeen.add(defect.code);
    if (defects.length > 0) continue;
    accepted += 1;
    let deepest = 0;
    let hasDerived = false;
    for (const node of g.nodes) {
      if (node.kind === 'derived') hasDerived = true;
      deepest = Math.max(deepest, derivationDepth(g, node.nodeId));
    }
    if (hasDerived) acceptedWithDerived += 1;
    deepestAccepted = Math.max(deepestAccepted, deepest);
  }

  // Every code, not the four the old assertion happened to list — and the two it
  // omitted were exactly the two the old generator could not produce.
  for (const code of EVIDENCE_GRAPH_DEFECT_CODES) {
    assert.ok(codesSeen.has(code), `the generator never produced ${code}`);
  }
  // The property must not be holding vacuously in most iterations.
  const derivedShare = acceptedWithDerived / accepted;
  assert.ok(derivedShare > 0.6, `only ${(derivedShare * 100).toFixed(1)}% of accepted graphs contain a derivation`);
  assert.ok(deepestAccepted >= 8, `deepest accepted derivation chain was only ${deepestAccepted}`);
});

test('graph: checkEvidenceGraph is deterministic over generated input', () => {
  const random = makeRandom(0xc0ffee);
  for (let iteration = 0; iteration < 2000; iteration += 1) {
    const g = generateGraph(random);
    assert.deepEqual(checkEvidenceGraph(g).slice(), checkEvidenceGraph(g).slice());
  }
});

test('graph: no generated input makes any checker throw', () => {
  // The four throw sites review found were all reachable only from shapes the
  // old generator could not build. Totality is now a fuzzed property.
  const random = makeRandom(0xd15ea5e);
  for (let iteration = 0; iteration < 5000; iteration += 1) {
    const g = generateGraph(random);
    assert.doesNotThrow(() => checkEvidenceGraph(g));
    for (const node of g.nodes) {
      assert.doesNotThrow(() => resolveEvidenceRoots(g, node.nodeId as string));
    }
  }
});

/* ── whole-recommendation references ──────────────────────────────── */

function offeredWith(options: OptionSet, nodes: readonly EvidenceNode[]): OfferedRecommendation {
  return {
    version: RECOMMENDATION_CONTRACT_VERSION,
    schema: RECOMMENDATION_SCHEMA_VERSION,
    recommendationId: 'rec-1',
    scopeId: 'scope-1',
    validity: { basisAt: '2026-08-19T10:00:00.000Z', expiresAt: '2026-08-19T11:00:00.000Z' },
    evidence: { nodes },
    inputDigest: 'digest-1',
    outcome: 'offered',
    options,
  };
}

function optionCiting(index: number, commitmentId: string, supportNode: string, basisNode: string) {
  return {
    optionIndex: index,
    action: { kind: 'do_now', commitmentId } as const,
    support: [{ code: 'OVERDUE', supportedBy: [supportNode], detail: 'the stated deadline has passed' }] as [
      { code: 'OVERDUE'; supportedBy: [string]; detail: string },
    ],
    confidence: { value: 0.8, band: bandForConfidence(0.8) as 'high', basis: [basisNode] as [string] },
  };
}

test('recommendation: a support reference into nothing is reported', () => {
  const rec = offeredWith(
    { kind: 'only_candidate', option: optionCiting(0, 'c1', 'ghost', 'a'), attested: ['a'] },
    [observed('a')],
  );
  const defects = checkRecommendation(rec);
  assert.deepEqual(codesOf(defects).slice(), ['UNKNOWN_EVIDENCE_NODE']);
  assert.equal(defects[0].optionIndex, 0);
  assert.ok(defects[0].detail.includes('support reason'));
});

test('recommendation: a dangling confidence basis is reported', () => {
  // The reference a hand-written checker forgets: it is nested two levels down,
  // while the other three sit at the top of their objects.
  const rec = offeredWith(
    { kind: 'only_candidate', option: optionCiting(0, 'c1', 'a', 'ghost'), attested: ['a'] },
    [observed('a')],
  );
  const defects = checkRecommendation(rec);
  assert.deepEqual(codesOf(defects).slice(), ['UNKNOWN_EVIDENCE_NODE']);
  assert.ok(defects[0].detail.includes('confidence basis'));
});

test('recommendation: a dangling exclusion reference is reported', () => {
  const rec = offeredWith(
    {
      kind: 'sole_survivor',
      option: optionCiting(0, 'c1', 'a', 'a'),
      excluded: [
        {
          action: { kind: 'do_now', commitmentId: 'c2' },
          exclusion: [{ code: 'LOWER_RANKED', supportedBy: ['ghost'], detail: 'ranked below the offered option' }],
        },
      ],
    },
    [observed('a')],
  );
  const defects = checkRecommendation(rec);
  assert.deepEqual(codesOf(defects).slice(), ['UNKNOWN_EVIDENCE_NODE']);
  assert.ok(defects[0].detail.includes('excluded candidate #0'));
});

test('recommendation: a dangling only-candidate attestation is reported', () => {
  // "Nothing else existed" is itself a claim, and decision 1 does not exempt
  // claims about absence.
  const rec = offeredWith(
    { kind: 'only_candidate', option: optionCiting(0, 'c1', 'a', 'a'), attested: ['ghost'] },
    [observed('a')],
  );
  const defects = checkRecommendation(rec);
  assert.deepEqual(codesOf(defects).slice(), ['UNKNOWN_EVIDENCE_NODE']);
  assert.ok(defects[0].detail.includes('attestation'));
});

test('recommendation: a withheld verdict cites evidence, and a dangling citation is reported', () => {
  const nodes = [
    observed('zero', {
      source: { kind: 'life_state_field', field: 'commitments', known: true },
      claim: { kind: 'quantity', value: 0, unit: 'count' },
      observedAt: null,
    }),
  ];
  const clean: WithheldRecommendation = {
    version: RECOMMENDATION_CONTRACT_VERSION,
    schema: RECOMMENDATION_SCHEMA_VERSION,
    recommendationId: 'rec-2',
    scopeId: 'scope-1',
    validity: { basisAt: '2026-08-19T10:00:00.000Z', expiresAt: '2026-08-19T11:00:00.000Z' },
    evidence: { nodes },
    inputDigest: 'digest-2',
    outcome: 'withheld',
    reasons: [{ code: 'NO_ELIGIBLE_CANDIDATE', supportedBy: ['zero'], detail: 'the scope holds no open commitment' }],
  };
  // LifeState's known-zero is what makes the empty scope citable, so the empty
  // case is not an exception carved out of "every claim traces to trusted state".
  assert.deepEqual(checkRecommendation(clean).slice(), []);

  const dangling: Recommendation = {
    ...clean,
    reasons: [{ code: 'NO_ELIGIBLE_CANDIDATE', supportedBy: ['ghost'], detail: 'the scope holds no open commitment' }],
  };
  const defects = checkRecommendation(dangling);
  assert.deepEqual(codesOf(defects).slice(), ['UNKNOWN_EVIDENCE_NODE']);
  assert.ok(defects[0].detail.includes('withholding reason'));
});

test('recommendation: the whole check is a superset of the graph check', () => {
  const nodes = [observed('a'), derived('bad', ['bad'])];
  const rec = offeredWith(
    { kind: 'only_candidate', option: optionCiting(0, 'c1', 'a', 'a'), attested: ['a'] },
    nodes,
  );
  const graphDefects = checkEvidenceGraph({ nodes });
  const allDefects = checkRecommendation(rec);
  assert.ok(graphDefects.length > 0, 'the fixture must be structurally broken');
  for (const defect of graphDefects) {
    assert.ok(
      allDefects.some((candidate) => candidate.code === defect.code && candidate.nodeId === defect.nodeId),
      `checkRecommendation dropped ${defect.nodeId}:${defect.code}`,
    );
  }
});

/* ── no identifier reaches a human-readable string ────────────────── */

const HOSTILE_IDS: readonly string[] = [
  'call-dr.cohen-about-the-biopsy',
  'tell-my-manager-i-am-quitting',
  'حجز-موعد-العلاج-الكيماوي',
  'לספר-לאמא-על-הגירושים',
];

test('leak: no defect detail carries a caller-chosen identifier', () => {
  // A character-class filter does not help, because the problem is not the
  // characters — these are ordinary ids that happen to be sentences. The only
  // safe rule is that details name things by index and by kind, and this test is
  // what holds it while three tracks add findings.
  for (const hostile of HOSTILE_IDS) {
    const nodes: readonly EvidenceNode[] = [
      observed(hostile, { valueFingerprint: '' }),
      observed(hostile),
      derived(`${hostile}-derived`, [hostile, 'ghost']),
      derived(`${hostile}-cycle-a`, [`${hostile}-cycle-b`]),
      derived(`${hostile}-cycle-b`, [`${hostile}-cycle-a`]),
      observed(''),
    ];
    const rec: OfferedRecommendation = {
      version: RECOMMENDATION_CONTRACT_VERSION,
      schema: RECOMMENDATION_SCHEMA_VERSION,
      recommendationId: hostile,
      scopeId: hostile,
      validity: { basisAt: '2026-08-19T10:00:00.000Z', expiresAt: '2026-08-19T11:00:00.000Z' },
      evidence: { nodes },
      inputDigest: 'digest',
      outcome: 'offered',
      options: {
        kind: 'choice',
        options: [
          optionCiting(0, hostile, 'ghost', 'ghost'),
          { ...optionCiting(9, hostile, hostile, hostile), confidence: { value: 5, band: 'high', basis: [hostile] as [string] } },
        ],
        excluded: [
          {
            action: { kind: 'decompose', commitmentId: hostile, proposalId: hostile },
            exclusion: [{ code: 'LOWER_RANKED', supportedBy: ['ghost'], detail: 'ranked below the offered options' }],
          },
        ],
      },
    };

    const defects = checkRecommendation(rec);
    assert.ok(defects.length > 5, 'the fixture must produce a broad spread of findings');
    for (const defect of defects) {
      assert.equal(
        defect.detail.includes(hostile),
        false,
        `detail for ${defect.code} leaked a caller-chosen id: ${defect.detail}`,
      );
      assert.equal(defect.detail.includes('ghost'), false, `detail for ${defect.code} leaked a referenced id`);
    }
  }
});

test('leak: the taxonomy is fully exercised by the leak fixture set', () => {
  // A leak test only covers the codes it triggers. This asserts the fixtures
  // above reach every graph-level code, so a new code cannot be added with an
  // id-carrying detail and go unnoticed here.
  const nodes: readonly EvidenceNode[] = [
    observed('dup'),
    observed('dup'),
    observed('nofp', { valueFingerprint: '' }),
    observed(''),
    derived('selfish', ['selfish']),
    derived('cyc-a', ['cyc-b']),
    derived('cyc-b', ['cyc-a']),
    derived('dangling', ['nowhere']),
    { kind: 'derived', nodeId: 'parentless', rule: 'OVERDUE_FROM_DUE_AT', claim: { kind: 'flag', value: true }, derivedFrom: [] } as unknown as EvidenceNode,
    { kind: 'inferred', nodeId: 'mystery', claim: { kind: 'flag', value: true } } as unknown as EvidenceNode,
  ];
  const found = new Set(checkEvidenceGraph({ nodes }).map((defect) => defect.code));
  for (const code of EVIDENCE_GRAPH_DEFECT_CODES) {
    assert.equal(found.has(code), true, `no fixture produces ${code}`);
  }
});

/* ── the counter-examples review built ────────────────────────────── */

test('graph: a derivation naming no parent is reported', () => {
  // The case that falsified the contract's central claim. It passed both
  // checkers and the staleness verdict while `resolveEvidenceRoots` returned
  // null — the contract contradicting itself in one line of JSON.
  const g = { nodes: [{ kind: 'derived', nodeId: 'd', rule: 'OVERDUE_FROM_DUE_AT', claim: { kind: 'flag', value: true }, derivedFrom: [] }] } as unknown as EvidenceGraph;
  assert.deepEqual(pairs(checkEvidenceGraph(g)).slice(), ['d:UNSOURCED_DERIVATION']);
  assert.equal(resolveEvidenceRoots(g, 'd'), null, 'and it must still not resolve');
});

test('graph: a node of unrecognised kind is reported, not silently exempted', () => {
  // Every pass in the contract is written as `if (node.kind !== 'observed')
  // continue`, so an unknown kind was exempt from all of them: never
  // fingerprint-checked, so it could never invalidate anything.
  const g = { nodes: [{ kind: 'inferred', nodeId: 'x', claim: { kind: 'flag', value: true } }] } as unknown as EvidenceGraph;
  assert.deepEqual(pairs(checkEvidenceGraph(g)).slice(), ['x:UNKNOWN_NODE_KIND']);
  assert.equal(resolveEvidenceRoots(g, 'x'), null, 'and it must not throw or resolve');
});

test('graph: a non-textual node id is reported under the code that exists for it', () => {
  const g = { nodes: [{ kind: 'observed', nodeId: 123, source: {}, claim: {}, observedAt: null, valueFingerprint: 'f' }] } as unknown as EvidenceGraph;
  assert.deepEqual(codesOf(checkEvidenceGraph(g)).slice(), ['BLANK_NODE_ID']);
});

test('graph: a malformed graph container is reported rather than thrown on', () => {
  for (const bad of [undefined, null, {}, { nodes: null }, { nodes: 'x' }]) {
    assert.doesNotThrow(() => checkEvidenceGraph(bad as unknown as EvidenceGraph));
    assert.deepEqual(checkEvidenceGraph(bad as unknown as EvidenceGraph).slice(), []);
    assert.equal(resolveEvidenceRoots(bad as unknown as EvidenceGraph, 'anything'), null);
  }
});

test('graph: a very deep derivation chain resolves without exhausting the stack', () => {
  // The recursive version raised a RangeError at roughly twelve thousand nodes,
  // out of a function documented never to throw, on input whose depth the
  // caller chooses.
  const nodes: EvidenceNode[] = [observed('r0')];
  for (let index = 1; index < 50000; index += 1) nodes.push(derived(`r${index}`, [`r${index - 1}`]));
  const g = { nodes };
  assert.deepEqual(checkEvidenceGraph(g).slice(), []);
  const roots = resolveEvidenceRoots(g, 'r49999');
  assert.notEqual(roots, null);
  assert.deepEqual((roots as readonly ObservedEvidence[]).map((node) => node.nodeId), ['r0']);
});

test('graph: cycle detection stays linear at scale', () => {
  // The previous detector was O(V·(V+E)) — 222ms at five thousand nodes — and
  // its backward-reachability pass was provably dead: after the forward guard
  // the node already reaches itself, so the intersection never excluded
  // anything. Tarjan replaces both. The bound here is loose on purpose; it is
  // guarding an order of growth, not a machine.
  const nodes: EvidenceNode[] = [observed('root')];
  for (let index = 1; index < 20000; index += 1) nodes.push(derived(`n${index}`, ['root']));
  const started = process.hrtime.bigint();
  assert.deepEqual(checkEvidenceGraph({ nodes }).slice(), []);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 2000, `checkEvidenceGraph took ${elapsedMs.toFixed(0)}ms on 20k nodes`);
});

/* ── mutation-killing assertions on resolveEvidenceRoots ──────────── */

test('graph: resolving nothing is null, never an empty list', () => {
  // Mutation that survived review: `return roots` instead of
  // `return roots.length > 0 ? roots : null`. Every other test masked it,
  // because the only graph reaching an empty root set is a parentless
  // derivation — which nothing generated.
  const g = { nodes: [{ kind: 'derived', nodeId: 'd', rule: 'OVERDUE_FROM_DUE_AT', claim: { kind: 'flag', value: true }, derivedFrom: [] }] } as unknown as EvidenceGraph;
  const roots = resolveEvidenceRoots(g, 'd');
  assert.equal(roots, null);
  assert.notDeepEqual(roots, [], 'an empty root list read as success is the surviving mutation');
});

test('graph: a cycle is unresolvable even when an observation hangs off it', () => {
  // Mutation that survived review: treating a re-entered node as settled. With
  // an observation reachable from the cycle, the root set is non-empty, so the
  // length check no longer masks it and this fails on the mutant.
  const g = graph(observed('obs'), derived('a', ['b', 'obs']), derived('b', ['a']));
  assert.equal(resolveEvidenceRoots(g, 'a'), null, 'a cycle must not resolve merely because a root is reachable');
  assert.ok(checkEvidenceGraph(g).some((defect) => defect.code === 'CYCLIC_EVIDENCE'));
});

/* ── option-set cardinality at the untyped boundary ───────────────── */

test('recommendation: a choice of one is reported', () => {
  // The acceptance criterion's exact failure, and it passed every check while
  // `minOptionsForChoice` sat exported and unread.
  const rec = offeredWith({ kind: 'choice', options: [optionCiting(0, 'c1', 'a', 'a')], excluded: [] } as unknown as OptionSet, [observed('a')]);
  assert.deepEqual(codesOf(checkRecommendation(rec)).slice(), ['CHOICE_BELOW_MINIMUM']);
});

test('recommendation: a lone option with no account of its solitude is reported', () => {
  const nodes = [observed('a')];
  const sole = offeredWith({ kind: 'sole_survivor', option: optionCiting(0, 'c1', 'a', 'a'), excluded: [] } as unknown as OptionSet, nodes);
  assert.deepEqual(codesOf(checkRecommendation(sole)).slice(), ['SOLE_OPTION_WITHOUT_ACCOUNT']);
  const only = offeredWith({ kind: 'only_candidate', option: optionCiting(0, 'c1', 'a', 'a'), attested: [] } as unknown as OptionSet, nodes);
  assert.deepEqual(codesOf(checkRecommendation(only)).slice(), ['SOLE_OPTION_WITHOUT_ACCOUNT']);
});

test('recommendation: an empty reason list is reported wherever it appears', () => {
  const nodes = [observed('a')];
  const noSupport = offeredWith(
    { kind: 'only_candidate', option: { ...optionCiting(0, 'c1', 'a', 'a'), support: [] }, attested: ['a'] } as unknown as OptionSet,
    nodes,
  );
  assert.deepEqual(codesOf(checkRecommendation(noSupport)).slice(), ['EMPTY_REASON_LIST']);

  const noExclusionReason = offeredWith(
    {
      kind: 'sole_survivor',
      option: optionCiting(0, 'c1', 'a', 'a'),
      excluded: [{ action: { kind: 'do_now', commitmentId: 'c2' }, exclusion: [] }],
    } as unknown as OptionSet,
    nodes,
  );
  assert.deepEqual(codesOf(checkRecommendation(noExclusionReason)).slice(), ['EMPTY_REASON_LIST']);

  const noWithholdingReason: Recommendation = {
    ...offeredWith({ kind: 'only_candidate', option: optionCiting(0, 'c1', 'a', 'a'), attested: ['a'] }, nodes),
    outcome: 'withheld',
    reasons: [],
  } as unknown as Recommendation;
  assert.deepEqual(codesOf(checkRecommendation(noWithholdingReason)).slice(), ['EMPTY_REASON_LIST']);
});

test('recommendation: citing nothing is a different finding from citing something absent', () => {
  const nodes = [observed('a')];
  const emptyBasis = offeredWith(
    {
      kind: 'only_candidate',
      option: { ...optionCiting(0, 'c1', 'a', 'a'), confidence: { value: 0.8, band: 'high', basis: [] } },
      attested: ['a'],
    } as unknown as OptionSet,
    nodes,
  );
  assert.deepEqual(codesOf(checkRecommendation(emptyBasis)).slice(), ['UNSOURCED_CLAIM']);

  const emptySupportedBy = offeredWith(
    {
      kind: 'only_candidate',
      option: { ...optionCiting(0, 'c1', 'a', 'a'), support: [{ code: 'OVERDUE', supportedBy: [], detail: 'x' }] },
      attested: ['a'],
    } as unknown as OptionSet,
    nodes,
  );
  assert.deepEqual(codesOf(checkRecommendation(emptySupportedBy)).slice(), ['UNSOURCED_CLAIM']);
});

test('recommendation: an unrecognised option-set or action kind is reported, not thrown on', () => {
  const nodes = [observed('a')];
  const badSet = offeredWith({ kind: 'mystery' } as unknown as OptionSet, nodes);
  assert.doesNotThrow(() => checkRecommendation(badSet));
  assert.deepEqual(codesOf(checkRecommendation(badSet)).slice(), ['UNKNOWN_OPTION_SET_KIND']);

  const badAction = offeredWith(
    {
      kind: 'only_candidate',
      option: { ...optionCiting(0, 'c1', 'a', 'a'), action: { kind: 'teleport', commitmentId: 'c1' } },
      attested: ['a'],
    } as unknown as OptionSet,
    nodes,
  );
  assert.deepEqual(codesOf(checkRecommendation(badAction)).slice(), ['UNKNOWN_ACTION_KIND']);
});

test('recommendation: two unrecognised actions do not collide into a false duplicate', () => {
  // `actionKey` fell off the end of its switch and returned `undefined` for an
  // unknown kind, so two *different* unrecognised actions compared equal and the
  // checker invented a DUPLICATE_OPTION_ACTION. A checker fabricating findings
  // is worse than one missing them, because the caller acts on it.
  const nodes = [observed('a')];
  const rec = offeredWith(
    {
      kind: 'choice',
      options: [
        { ...optionCiting(0, 'c1', 'a', 'a'), action: { kind: 'teleport', commitmentId: 'c1' } },
        { ...optionCiting(1, 'c2', 'a', 'a'), action: { kind: 'teleport', commitmentId: 'c2' } },
      ],
      excluded: [],
    } as unknown as OptionSet,
    nodes,
  );
  const codes = codesOf(checkRecommendation(rec));
  assert.equal(codes.includes('DUPLICATE_OPTION_ACTION'), false, 'two distinct unknown actions are not a duplicate');
  assert.deepEqual(codes.filter((code) => code === 'UNKNOWN_ACTION_KIND').length, 2);
});

test('recommendation: no malformed offer makes the checker throw', () => {
  const nodes = [observed('a')];
  const shapes: readonly unknown[] = [
    undefined,
    null,
    { ...offeredWith({ kind: 'only_candidate', option: optionCiting(0, 'c1', 'a', 'a'), attested: ['a'] }, nodes), options: undefined },
    { ...offeredWith({ kind: 'only_candidate', option: optionCiting(0, 'c1', 'a', 'a'), attested: ['a'] }, nodes), evidence: undefined },
    { ...offeredWith({ kind: 'choice', options: [optionCiting(0, 'c1', 'a', 'a'), optionCiting(1, 'c2', 'a', 'a')], excluded: [] }, nodes), options: { kind: 'choice', options: 'nope', excluded: 'nope' } },
    { ...offeredWith({ kind: 'only_candidate', option: optionCiting(0, 'c1', 'a', 'a'), attested: ['a'] }, nodes), options: { kind: 'only_candidate', option: undefined, attested: ['a'] } },
  ];
  for (const shape of shapes) {
    assert.doesNotThrow(() => checkRecommendation(shape as unknown as Recommendation), `threw on ${JSON.stringify(shape)?.slice(0, 60)}`);
  }
});
