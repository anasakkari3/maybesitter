/**
 * The feature-flag gate mobile routes close behind (UC-2.7a, #167).
 *
 * ── 404, not 403 ─────────────────────────────────────────────────
 *
 * A disabled module has no endpoint, and that is what the answer says. The
 * same reasoning as `src/middleware.ts`: a 403 tells a caller the route exists
 * and is merely switched off, which is a fact about our rollout that nobody
 * outside needs. It is also what the client wants — #167's memory card hides
 * itself on a 404 and would have to special-case anything else.
 *
 * ── Read per request ─────────────────────────────────────────────
 *
 * `resolveModuleRuntime` reads `process.env` each call, so flipping
 * `MAYBESITTER_KILL_SWITCH_MEMORY` on a running revision takes effect on the
 * next request rather than the next deploy. That is the point of a kill switch,
 * and caching the decision here would take it away.
 */
import {
  resolveModuleRuntime,
  type ModuleRuntimeDecision,
} from '../../../src/contracts/v1/runtimeControls';
import type { IntelligenceModuleName } from '../../../src/contracts/v1/moduleContracts';

/** A `Response` when the module is off, `undefined` when the route may run. */
export function moduleDisabledResponse(module: IntelligenceModuleName): Response | undefined {
  const decision: ModuleRuntimeDecision = resolveModuleRuntime(module);
  if (decision.mode === 'enabled') return undefined;
  return Response.json({ success: false, error: 'not found', reason: 'feature_unavailable' }, { status: 404 });
}
