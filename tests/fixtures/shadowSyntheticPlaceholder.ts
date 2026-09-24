/**
 * The synthetic placeholder: what exercises the shadow chain's `placeholder`
 * role now that no real module holds it (#131).
 *
 * ── Why this exists ──────────────────────────────────────────────
 *
 * Until #131, `priority` was the chain's only placeholder, and so the only thing
 * that exercised skipping (`module_placeholder`), placeholder degradation,
 * non-contribution, `PLACEHOLDER_MODULE_CLAIMS_COMPLETION`, the drill's
 * `skipped_no_fallback` stance and the switch-before-role precedence. #131
 * flipped `priority` to implemented in the registry and in `SHADOW_MODULE_ROLES`
 * together. Left there, every one of those paths would have become code nothing
 * runs — and they are exactly the paths that matter on the day a module enters
 * the chain before its implementation does.
 *
 * ── Why it is a role table and not a new module ──────────────────
 *
 * `ShadowPipelineModule` is the chain's literal tuple, so a module that is not
 * in the chain cannot be walked, checked or traced without widening the
 * contract's types for the sake of a test. What *can* be synthetic is the role:
 * a table identical to `SHADOW_MODULE_ROLES` except that one slot is stubbed.
 * The orchestrator (`ShadowOrchestratorDeps.roles`), the outcome checker
 * (`checkShadowPipelineOutcome`'s second argument) and the drill
 * (`ShadowDrillChainProfile`) each accept one, and default to the real tables.
 *
 * ── Why `memory` holds the slot ─────────────────────────────────
 *
 * The slot has to have the properties `priority` had as the placeholder, or the
 * tests re-pointed here would be testing something else:
 *
 *  - `degrade_open`, so a skipped placeholder degrades the run instead of
 *    withholding it;
 *  - nobody's prerequisite (`SHADOW_MODULE_PREREQUISITES`) and nobody's hard
 *    dependency (`SHADOW_DRILL_HARD_DEPENDENCY`), so its skip is a pure
 *    non-contribution with no cascade behind it;
 *  - proposes no effect, in the real adapters or the drill's, so stubbing it
 *    removes nothing from a deliverable's `proposedEffects`.
 *
 * `memory` and `priority` are the only two modules with all three
 * (`decomposition` and `planning` pass the first two and propose).
 * `priority` is deliberately not the one chosen: a test that stubs `priority`
 * reads as a claim that priority is still a stub, which is the stale fact #131
 * removed. `the synthetic placeholder has the shape the old placeholder had`
 * in `tests/shadowPipeline/registryDrift.test.ts` asserts every property above,
 * so moving the slot is a failing test rather than a quiet change of meaning.
 *
 * The fail-closed interaction — a placeholder in the `fail_closed` slot — is
 * covered separately by a sweep that stubs each slot in turn
 * (`syntheticPlaceholderRolesAt`), because no single slot can show both
 * degradation and withholding.
 */

import {
  SHADOW_MODULE_ROLES,
  type ShadowModuleRoleTable,
  type ShadowPipelineModule,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import {
  SHADOW_KILL_SWITCH_STANCE,
  type ShadowDrillChainProfile,
} from '../../lib/operations/shadowDrillPipeline.ts';

/** The one slot the default synthetic table stubs. */
export const SYNTHETIC_PLACEHOLDER_MODULE = 'memory' as const satisfies ShadowPipelineModule;

/** The real role table with `module` stubbed, and nothing else changed. */
export function syntheticPlaceholderRolesAt(module: ShadowPipelineModule): ShadowModuleRoleTable {
  return Object.freeze({ ...SHADOW_MODULE_ROLES, [module]: 'placeholder' as const });
}

/** The real role table with `SYNTHETIC_PLACEHOLDER_MODULE` stubbed. */
export const SYNTHETIC_PLACEHOLDER_ROLES: ShadowModuleRoleTable = syntheticPlaceholderRolesAt(
  SYNTHETIC_PLACEHOLDER_MODULE,
);

/**
 * The drill's view of the same stub: the placeholder's role *and* its stance,
 * moved together. A placeholder whose stance still said `rules_only_fallback`
 * would fall back into a stub — see `ShadowDrillChainProfile`.
 */
export const SYNTHETIC_PLACEHOLDER_DRILL_PROFILE: ShadowDrillChainProfile = Object.freeze({
  roles: SYNTHETIC_PLACEHOLDER_ROLES,
  killSwitchStance: Object.freeze({
    ...SHADOW_KILL_SWITCH_STANCE,
    [SYNTHETIC_PLACEHOLDER_MODULE]: 'skipped_no_fallback' as const,
  }),
});
