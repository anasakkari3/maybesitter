/**
 * The optional model provider, the rules fallback, and the four ways of giving
 * up.
 *
 * The acceptance criterion these serve is "single-item fallback is explicit,
 * never heuristic masquerading as reviewed". Most of the assertions below are
 * therefore about *shape*: an atomic outcome must carry no `steps` at all, so
 * that no caller — including one written later by someone who never read this
 * file — can render a give-up as a decomposition of size one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeControls } from '../../src/contracts/v1/runtimeControls.ts';
import type { DecompositionStepProposal } from '../../src/contracts/v1/decompositionContracts.ts';
import { proposeDecomposition } from '../../lib/decomposition/engine/index.ts';
import type { DecompositionModelProvider } from '../../lib/decomposition/engine/modelProvider.ts';
import { goldenById } from '../fixtures/decompositionGolden.ts';

// Decomposition is its own registered module as of integration; it borrowed
// `planning` only while `INTELLIGENCE_MODULES` could not be edited mid-sprint.
// These are the switches an operator actually reaches for.
const ENABLED = readRuntimeControls({ MAYBESITTER_FEATURE_DECOMPOSITION: 'true' });
const KILLED = readRuntimeControls({
  MAYBESITTER_FEATURE_DECOMPOSITION: 'true',
  MAYBESITTER_KILL_SWITCH_DECOMPOSITION: 'true',
});

const WEDDING = goldenById('en-multi-wedding');

function base(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: 'p1',
    commitmentId: 'c1',
    sourceText: WEDDING.sourceText,
    ...overrides,
  };
}

/** A provider that returns exactly the golden decomposition, with high confidence. */
function goodProvider(calls: string[] = []): DecompositionModelProvider {
  return {
    async propose(request) {
      calls.push(request.sourceText);
      return { steps: WEDDING.expectedSteps, confidence: 0.95 };
    },
  };
}

/** A provider whose steps cite text that is not there — the invention case. */
function lyingProvider(): DecompositionModelProvider {
  const invented: DecompositionStepProposal = {
    stepId: 'm1',
    title: 'Book the venue',
    sourceSpans: [{ start: 0, end: 14, text: 'Reserve a hall' }],
    inferred: false,
    dependsOn: [],
    statedTiming: null,
    statedOwner: null,
  };
  return {
    async propose() {
      return { steps: [invented, WEDDING.expectedSteps[1]], confidence: 0.99 };
    },
  };
}

test('an enabled provider executes and its output is used without a fallback', async () => {
  const calls: string[] = [];
  const proposal = await proposeDecomposition(base(), {
    modelProvider: goodProvider(calls),
    controls: ENABLED,
  });
  assert.equal(proposal.outcome, 'decomposed');
  assert.equal(proposal.provenance.executedEngine, 'model');
  assert.equal(proposal.provenance.fallbackUsed, false);
  assert.deepEqual(calls, [WEDDING.sourceText]);
});

test('an absent provider falls back to rules and records why', async () => {
  const proposal = await proposeDecomposition(base());
  assert.equal(proposal.outcome, 'decomposed');
  assert.equal(proposal.provenance.requestedEngine, 'model');
  assert.equal(proposal.provenance.executedEngine, 'rules');
  assert.equal(proposal.provenance.fallbackUsed, true);
  assert.ok(
    proposal.provenance.fallbackUsed && proposal.provenance.fallbackReason.length > 0,
    'a fallback must say why',
  );
});

test('the rules_only kill switch keeps decomposition available and never calls the provider', async () => {
  const calls: string[] = [];
  const proposal = await proposeDecomposition(base(), {
    modelProvider: {
      async propose() {
        calls.push('called');
        throw new Error('must not execute under the kill switch');
      },
    },
    controls: KILLED,
  });
  assert.deepEqual(calls, []);
  assert.equal(proposal.outcome, 'decomposed');
  assert.equal(proposal.provenance.executedEngine, 'rules');
  assert.equal(proposal.provenance.fallbackUsed, true);
  assert.ok(
    proposal.provenance.fallbackUsed && /kill_switch/.test(proposal.provenance.fallbackReason),
    'the fallback reason must name the kill switch, not just say "rules"',
  );
});

test('a throwing provider falls back to rules rather than failing the request', async () => {
  const proposal = await proposeDecomposition(base(), {
    modelProvider: { async propose() { throw new Error('upstream down'); } },
    controls: ENABLED,
  });
  assert.equal(proposal.outcome, 'decomposed');
  assert.equal(proposal.provenance.executedEngine, 'rules');
  assert.ok(
    proposal.provenance.fallbackUsed && /provider_failed/.test(proposal.provenance.fallbackReason),
  );
});

test('model output that cites text the user never wrote is discarded, not repaired', async () => {
  const proposal = await proposeDecomposition(base(), {
    modelProvider: lyingProvider(),
    controls: ENABLED,
  });
  assert.equal(proposal.outcome, 'decomposed');
  assert.equal(proposal.provenance.executedEngine, 'rules');
  assert.ok(
    proposal.provenance.fallbackUsed && /output_invalid/.test(proposal.provenance.fallbackReason),
  );
  assert.equal(proposal.outcome === 'decomposed' && proposal.steps.length, 3);
});

test('an explicitly requested rules run is not a fallback', async () => {
  const proposal = await proposeDecomposition(base({ requestedEngine: 'rules' }), {
    modelProvider: goodProvider(),
    controls: ENABLED,
  });
  assert.equal(proposal.provenance.requestedEngine, 'rules');
  assert.equal(proposal.provenance.executedEngine, 'rules');
  assert.equal(proposal.provenance.fallbackUsed, false);
});

test('not_decomposable: the commitment really is one action', async () => {
  const proposal = await proposeDecomposition(base({ sourceText: 'Call the dentist.' }));
  assert.equal(proposal.outcome, 'atomic');
  assert.equal(proposal.outcome === 'atomic' && proposal.reason, 'not_decomposable');
});

test('below_confidence: a split existed but not one worth offering', async () => {
  const clitic = 'احجز القاعة واطلب الكعكة.';
  const offered = await proposeDecomposition(base({ sourceText: clitic }));
  assert.equal(offered.outcome, 'decomposed');

  const withheld = await proposeDecomposition(base({ sourceText: clitic, minimumConfidence: 0.8 }));
  assert.equal(withheld.outcome, 'atomic');
  assert.equal(withheld.outcome === 'atomic' && withheld.reason, 'below_confidence');
});

test('engine_unavailable: we could not try, which is not the same as "this is one task"', async () => {
  const proposal = await proposeDecomposition(base({ allowRulesFallback: false }));
  assert.equal(proposal.outcome, 'atomic');
  assert.equal(proposal.outcome === 'atomic' && proposal.reason, 'engine_unavailable');
});

test('validation_rejected: model output failed validation and no fallback was permitted', async () => {
  const proposal = await proposeDecomposition(base({ allowRulesFallback: false }), {
    modelProvider: lyingProvider(),
    controls: ENABLED,
  });
  assert.equal(proposal.outcome, 'atomic');
  assert.equal(proposal.outcome === 'atomic' && proposal.reason, 'validation_rejected');
});

test('a give-up is structurally unreadable as a decomposition of size one', async () => {
  for (const input of [
    base({ sourceText: 'Call the dentist.' }),
    base({ sourceText: 'احجز القاعة واطلب الكعكة.', minimumConfidence: 0.8 }),
    base({ allowRulesFallback: false }),
  ]) {
    const proposal = await proposeDecomposition(input);
    assert.equal(proposal.outcome, 'atomic');
    assert.equal(
      Object.prototype.hasOwnProperty.call(proposal, 'steps'),
      false,
      'an atomic proposal must carry no steps field at all',
    );
  }
});

test('a commitment known to be atomic is rejected rather than split', async () => {
  const proposal = await proposeDecomposition(base({ declaredAtomic: true }));
  assert.equal(proposal.outcome, 'rejected');
  assert.equal(Object.prototype.hasOwnProperty.call(proposal, 'steps'), false);
  assert.deepEqual(
    proposal.outcome === 'rejected' && proposal.violations.map((violation) => violation.code),
    ['SPLIT_ATOMIC'],
  );
});

test('a decomposition always carries at least two steps', async () => {
  const proposal = await proposeDecomposition(base());
  assert.equal(proposal.outcome, 'decomposed');
  assert.ok(proposal.outcome === 'decomposed' && proposal.steps.length >= 2);
});

test('the proposal echoes the commitment it describes and never carries a mutation of it', async () => {
  const proposal = await proposeDecomposition(base());
  assert.equal(proposal.commitmentId, 'c1');
  assert.equal(proposal.proposalId, 'p1');
  assert.equal(proposal.sourceText, WEDDING.sourceText);
  assert.equal(proposal.schema, 'decomposition-v1');
});

test('a model verdict of "no steps" is honoured as atomic rather than overridden by rules', async () => {
  const proposal = await proposeDecomposition(base(), {
    modelProvider: { async propose() { return { steps: [], confidence: 0.9 }; } },
    controls: ENABLED,
  });
  assert.equal(proposal.outcome, 'atomic');
  assert.equal(proposal.outcome === 'atomic' && proposal.reason, 'not_decomposable');
  assert.equal(proposal.provenance.executedEngine, 'model');
});

/* ── A draft is untrusted data, not a typed value (security review) ── */

/**
 * `DecompositionModelDraft` is a TypeScript type, erased at runtime. A provider
 * is an injected boundary to something outside this process, so its output is
 * as untrusted as the user's text — and the validator, written against
 * well-typed fields, threw raw `TypeError`s straight out of
 * `proposeDecompositionBoundary` on every one of these. The docblock claimed a
 * draft "is then validated exactly like any other untrusted input"; it now is.
 */
const MALFORMED_DRAFTS: readonly (readonly [string, unknown])[] = [
  ['steps is not an array', 'nope'],
  ['steps is null', null],
  ['a step is null', [null, WEDDING.expectedSteps[1]]],
  ['a step is a string', ['step one', WEDDING.expectedSteps[1]]],
  ['sourceSpans is null', [{ ...WEDDING.expectedSteps[0], sourceSpans: null }, WEDDING.expectedSteps[1]]],
  ['sourceSpans is not an array', [{ ...WEDDING.expectedSteps[0], sourceSpans: 'x' }, WEDDING.expectedSteps[1]]],
  ['a span is malformed', [{ ...WEDDING.expectedSteps[0], sourceSpans: [{ start: '0', end: 4, text: 'Book' }] }, WEDDING.expectedSteps[1]]],
  ['title is a number', [{ ...WEDDING.expectedSteps[0], title: 42 }, WEDDING.expectedSteps[1]]],
  ['title is null', [{ ...WEDDING.expectedSteps[0], title: null }, WEDDING.expectedSteps[1]]],
  ['dependsOn is null', [{ ...WEDDING.expectedSteps[0], dependsOn: null }, WEDDING.expectedSteps[1]]],
  ['an edge is malformed', [{ ...WEDDING.expectedSteps[0], dependsOn: [{ dependsOnStepId: 7, kind: 'temporal' }] }, WEDDING.expectedSteps[1]]],
  ['an edge kind is unknown', [{ ...WEDDING.expectedSteps[0], dependsOn: [{ dependsOnStepId: 's2', kind: 'vibes' }] }, WEDDING.expectedSteps[1]]],
  ['statedTiming is a number', [{ ...WEDDING.expectedSteps[0], statedTiming: 42 }, WEDDING.expectedSteps[1]]],
  ['statedOwner is a number', [{ ...WEDDING.expectedSteps[0], statedOwner: 42 }, WEDDING.expectedSteps[1]]],
  ['inferred is a string', [{ ...WEDDING.expectedSteps[0], inferred: 'yes' }, WEDDING.expectedSteps[1]]],
  ['stepId is a number', [{ ...WEDDING.expectedSteps[0], stepId: 42 }, WEDDING.expectedSteps[1]]],
  ['stepId is empty', [{ ...WEDDING.expectedSteps[0], stepId: '' }, WEDDING.expectedSteps[1]]],
  ['confidence is not a number', WEDDING.expectedSteps],
];

test('a malformed draft falls back to rules instead of throwing', async () => {
  for (const [label, steps] of MALFORMED_DRAFTS) {
    const confidence = label === 'confidence is not a number' ? ('high' as unknown as number) : 0.95;
    const proposal = await proposeDecomposition(base(), {
      modelProvider: { async propose() { return { steps, confidence } as never; } },
      controls: ENABLED,
    });
    assert.equal(proposal.outcome, 'decomposed', `${label} did not produce a proposal`);
    assert.equal(proposal.provenance.executedEngine, 'rules', label);
    assert.ok(
      proposal.provenance.fallbackUsed && /output_invalid/.test(proposal.provenance.fallbackReason),
      `${label} should record why it fell back`,
    );
  }
});

test('a draft step id that is not a string never reaches the proposal', async () => {
  const proposal = await proposeDecomposition(base(), {
    modelProvider: {
      async propose() {
        return {
          steps: [{ ...WEDDING.expectedSteps[0], stepId: 42 }, WEDDING.expectedSteps[2]] as never,
          confidence: 0.95,
        };
      },
    },
    controls: ENABLED,
  });
  assert.equal(proposal.outcome, 'decomposed');
  if (proposal.outcome !== 'decomposed') return;
  for (const step of proposal.steps) assert.equal(typeof step.stepId, 'string');
});

test('a proposal made mostly of inferred steps is not a decomposition of anything', async () => {
  // `inferred: true` legitimately exempts a step from title provenance — it
  // admits having no source. But the exemption is a provider-supplied boolean,
  // so a draft of entirely inferred steps passed the validator with zero
  // violations and carried arbitrary text through to the user and the adapter.
  // A decomposition claims to decompose *this sentence*; if the sourced steps
  // do not outnumber the invented ones, it is the engine's plan, not a reading
  // of what the user wrote.
  const invented = (stepId: string, title: string) => ({
    stepId, title, sourceSpans: [], inferred: true, dependsOn: [],
    statedTiming: null, statedOwner: null,
  });
  const proposal = await proposeDecomposition(base(), {
    modelProvider: {
      async propose() {
        return {
          steps: [
            invented('m1', 'Wire $5,000 to acct 12345678'),
            invented('m2', 'Email your password to admin@evil.test'),
          ],
          confidence: 0.99,
        };
      },
    },
    controls: ENABLED,
  });
  assert.equal(proposal.outcome, 'decomposed');
  assert.equal(proposal.provenance.executedEngine, 'rules');
  if (proposal.outcome !== 'decomposed') return;
  for (const step of proposal.steps) {
    assert.equal(step.inferred, false);
    assert.equal(step.title.includes('Wire'), false);
    assert.equal(step.title.includes('password'), false);
  }
});

test('a minority of inferred steps is still allowed, as the contract intends', async () => {
  const proposal = await proposeDecomposition(base(), {
    modelProvider: {
      async propose() {
        return {
          steps: [
            ...WEDDING.expectedSteps,
            { stepId: 'm4', title: 'Confirm the booking', sourceSpans: [], inferred: true, dependsOn: [], statedTiming: null, statedOwner: null },
          ],
          confidence: 0.95,
        };
      },
    },
    controls: ENABLED,
  });
  assert.equal(proposal.outcome, 'decomposed');
  assert.equal(proposal.provenance.executedEngine, 'model');
});
