/**
 * `SHADOW_MODULE_ROLES` against the registry it restates.
 *
 * Merge-owned, because it is about two files agreeing and neither can own it.
 *
 * ── Why this exists ──────────────────────────────────────────────
 *
 * `SHADOW_MODULE_ROLES` says which chain modules are implemented. So does
 * `INTELLIGENCE_MODULE_CONTRACTS`. They are two hand-maintained lists of one
 * fact, and until now nothing compared them — so the shadow orchestrator's
 * behaviour was governed by a copy while the registry was free to drift away
 * from it.
 *
 * That was not hypothetical. `INTELLIGENCE_MODULE_CONTRACTS.priority` reads
 * `not_implemented_in_sprint_00` while `lib/priority/priorityScorer.ts` is real
 * and imported by shipped code (`lib/utils/agendaScoring.ts`). Integration
 * corrected the registry entry to see what would happen and **nothing failed**:
 * the orchestrator kept skipping priority because it reads the copy. The
 * orchestrator suite has a test whose comment promises the opposite —
 * "if someone implements priority and updates the registry, this test fails and
 * the update becomes a decision rather than a drift". It did not fail. That
 * comment has been corrected, and this file is the check it described.
 *
 * ── Why the role table is not simply derived ─────────────────────
 *
 * It cannot be. A module's implemented-ness lives inside the return value of an
 * **async** `execute`, and `SHADOW_MODULE_ROLES` is needed at module-evaluation
 * time. So the restatement is structural, and the honest answer to a
 * restatement that cannot be removed is a test that binds it — which is the
 * same answer this repo already reached for the schema-version literals in
 * `moduleContracts.ts`, where importing the constant back would close a TDZ
 * cycle.
 *
 * ── Why the flip was not made here ───────────────────────────────
 *
 * Correcting the registry *and* the role table together is right, and it is not
 * an integration-time change: `priority` is the only placeholder in the chain,
 * so it is the sole exemplar the contract suite uses to exercise skipping,
 * degradation, non-contribution and the fail-closed interaction. Flipping it
 * failed 67 tests and would have left the `placeholder` path with nothing
 * exercising it at all. Filed instead, with this test as the tripwire so the
 * two lists cannot drift further apart in the meantime.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { INTELLIGENCE_MODULE_CONTRACTS } from '../../src/contracts/v1/moduleContracts.ts';
import {
  SHADOW_MODULE_ROLES,
  SHADOW_PIPELINE_CHAIN,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';

const PROVENANCE = {
  traceId: 'registry-drift',
  producedAt: '2026-08-21T00:00:00.000Z',
  source: 'system',
  confidence: null,
} as const;

/**
 * A module is a placeholder **iff** its descriptor answers exactly the
 * not-implemented sentinel. Anything else means it does something.
 *
 * Not "iff `status === 'implemented'`", which was this helper's first form and
 * was wrong about `capture`: its descriptor returns a domain payload,
 * `{ disposition, commitmentCount }`, with no `status` field at all. Six of the
 * eight use the `ImplementedModuleOutput` envelope, `priority` uses the
 * placeholder sentinel, and `capture` uses neither — so a predicate written
 * around the envelope reports the one module that does the most work as the one
 * that does none.
 *
 * Reading the sentinel is the honest test because the sentinel is what the
 * placeholder executor emits, and it is the only shape that *claims* absence.
 */
const NOT_IMPLEMENTED_SENTINEL = 'not_implemented_in_sprint_00';

async function registryRoleOf(module: (typeof SHADOW_PIPELINE_CHAIN)[number]): Promise<{
  readonly role: 'implemented' | 'placeholder';
  readonly output: string;
}> {
  const result = await INTELLIGENCE_MODULE_CONTRACTS[module].execute({
    provenance: PROVENANCE,
    input: {},
  } as never);
  assert.equal(result.ok, true, `${module}'s descriptor did not execute`);
  const output = result.ok ? (result.output as { status?: unknown }) : {};
  const role = output.status === NOT_IMPLEMENTED_SENTINEL ? 'placeholder' : 'implemented';
  return { role, output: JSON.stringify(output) };
}

test('every chain module’s role matches what the registry says about it', async () => {
  // The whole chain, one entry at a time, with the module named in the message —
  // a single deepEqual over two objects would say "these differ" and leave the
  // reader to find which.
  for (const module of SHADOW_PIPELINE_CHAIN) {
    const { role, output } = await registryRoleOf(module);
    assert.equal(
      SHADOW_MODULE_ROLES[module],
      role,
      `SHADOW_MODULE_ROLES says ${module} is "${SHADOW_MODULE_ROLES[module]}" while its descriptor ` +
        `answers ${output}. The orchestrator reads the role table, so a registry entry is inert ` +
        `until both move together — see this file's header, and the issue tracking the priority flip.`,
    );
  }
});

test('the role table covers the chain exactly, so a new module cannot arrive unclassified', async () => {
  // Both directions. A module in the chain with no role would read as undefined
  // and take whichever branch `!== 'placeholder'` happens to give it.
  assert.deepEqual(
    Object.keys(SHADOW_MODULE_ROLES).slice().sort(),
    [...SHADOW_PIPELINE_CHAIN].slice().sort(),
  );
});

test('the registry disagreement this test was written for is the one that exists, and only that one', async () => {
  // A named inventory of known drift, so closing it is a deliberate edit here
  // rather than a test that quietly starts passing. Empty is the goal state.
  const drifted: string[] = [];
  for (const module of SHADOW_PIPELINE_CHAIN) {
    const { role } = await registryRoleOf(module);
    if (SHADOW_MODULE_ROLES[module] !== role) drifted.push(module);
  }
  assert.deepEqual(
    drifted,
    [],
    'the two lists disagree; the first test above names which and why it matters',
  );
});
