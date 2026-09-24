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
 * That was not hypothetical. `INTELLIGENCE_MODULE_CONTRACTS.priority` read
 * `not_implemented_in_sprint_00` while `lib/priority/priorityScorer.ts` was real
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
 * ── The flip, and what exercises the placeholder path now ────────
 *
 * Correcting the registry *and* the role table together was right, and it was
 * not an integration-time change: `priority` was the only placeholder in the
 * chain, so it was the sole exemplar the suites used to exercise skipping,
 * degradation, non-contribution and the fail-closed interaction. Integration
 * filed it (#131) with this file as the tripwire.
 *
 * #131 made the flip: both tables moved in one commit, and the drift inventory
 * below is empty with no module in it. The placeholder path is now exercised
 * through a synthetic role table (`tests/fixtures/shadowSyntheticPlaceholder.ts`)
 * — and because a synthetic stand-in is only as good as its resemblance to what
 * it stands in for, the last test here pins the properties that make it one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { INTELLIGENCE_MODULE_CONTRACTS } from '../../src/contracts/v1/moduleContracts.ts';
import {
  SHADOW_MODULE_FAILURE_STANCE,
  SHADOW_MODULE_ROLES,
  SHADOW_PIPELINE_CHAIN,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { SHADOW_MODULE_PREREQUISITES } from '../../lib/shadowPipeline/orchestrator.ts';
import {
  SHADOW_DRILL_HARD_DEPENDENCY,
  SHADOW_KILL_SWITCH_STANCE,
} from '../../lib/operations/shadowDrillPipeline.ts';
import {
  SYNTHETIC_PLACEHOLDER_DRILL_PROFILE,
  SYNTHETIC_PLACEHOLDER_MODULE,
  SYNTHETIC_PLACEHOLDER_ROLES,
} from '../fixtures/shadowSyntheticPlaceholder.ts';

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
 * `{ disposition, commitmentCount }`, with no `status` field at all. Seven of
 * the eight use the `ImplementedModuleOutput` envelope (six did while `priority`
 * still answered the placeholder sentinel), and `capture` uses neither — so a
 * predicate written
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

test('no chain module is a placeholder in either table, and priority is the one #131 moved', async () => {
  // The positive half of the flip, stated so that reverting it is a named
  // failure and not only a drift: both tables say implemented for every module,
  // and the priority descriptor names the entry point the shadow adapter binds.
  for (const module of SHADOW_PIPELINE_CHAIN) {
    assert.equal(SHADOW_MODULE_ROLES[module], 'implemented', `${module} is a placeholder in the role table`);
    const { role, output } = await registryRoleOf(module);
    assert.equal(role, 'implemented', `${module}'s descriptor answers the placeholder sentinel: ${output}`);
  }
  const priority = await INTELLIGENCE_MODULE_CONTRACTS.priority.execute({
    provenance: PROVENANCE,
    input: {},
  } as never);
  assert.equal(priority.ok, true);
  assert.deepEqual(priority.ok ? priority.output : null, {
    status: 'implemented',
    module: 'priority',
    schemaVersion: 'priority-v1',
    entryPoint: 'lib/priority/priorityScorer#rankPriorities',
  });
});

test('the synthetic placeholder has the shape the old placeholder had', () => {
  // What the re-pointed placeholder tests rely on, one property at a time. If
  // any of these stops holding, those tests are testing something else — a
  // placeholder that withholds, or one whose skip cascades — while still
  // passing.
  const module = SYNTHETIC_PLACEHOLDER_MODULE;

  // Exactly one slot differs from the real table, and it is the named one.
  const differing = SHADOW_PIPELINE_CHAIN.filter(
    (candidate) => SYNTHETIC_PLACEHOLDER_ROLES[candidate] !== SHADOW_MODULE_ROLES[candidate],
  );
  assert.deepEqual(differing, [module]);
  assert.equal(SYNTHETIC_PLACEHOLDER_ROLES[module], 'placeholder');

  // Degrade-open: a skipped placeholder degrades the run, never withholds it.
  assert.equal(SHADOW_MODULE_FAILURE_STANCE[module], 'degrade_open');

  // Nobody needs it, so its skip cascades nowhere — in the orchestrator's
  // wiring or in the drill's.
  for (const candidate of SHADOW_PIPELINE_CHAIN) {
    assert.equal(
      SHADOW_MODULE_PREREQUISITES[candidate].includes(module),
      false,
      `${candidate} lists the synthetic placeholder as a prerequisite`,
    );
    assert.notEqual(
      SHADOW_DRILL_HARD_DEPENDENCY[candidate],
      module,
      `${candidate} hard-depends on the synthetic placeholder in the drill`,
    );
  }

  // It is not priority: a stubbed priority would read as the stale fact #131
  // removed.
  assert.notEqual(module, 'priority');

  // The drill profile moves the role and the stance together, and nothing else.
  assert.equal(SYNTHETIC_PLACEHOLDER_DRILL_PROFILE.roles, SYNTHETIC_PLACEHOLDER_ROLES);
  assert.deepEqual(
    SHADOW_PIPELINE_CHAIN.filter(
      (candidate) =>
        SYNTHETIC_PLACEHOLDER_DRILL_PROFILE.killSwitchStance[candidate] !== SHADOW_KILL_SWITCH_STANCE[candidate],
    ),
    [module],
  );
  assert.equal(SYNTHETIC_PLACEHOLDER_DRILL_PROFILE.killSwitchStance[module], 'skipped_no_fallback');
});
