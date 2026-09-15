/**
 * Whether this deployment accepts shares at all (UC-3.0, #183 step 10).
 *
 * ── 404, not 403 ─────────────────────────────────────────────────
 *
 * The same answer `lib/services/mobile/moduleGate.ts` gives, for the same two
 * reasons: a 403 tells a caller the route exists and is merely switched off,
 * which is a fact about our rollout nobody outside needs; and it is what the
 * client wants, because the share screen's "not yet" notice is the same screen
 * whether the flag is off on the phone or on the server.
 *
 * ── Not a module in `runtimeControls`' sense ─────────────────────
 *
 * `resolveModuleRuntime` is keyed by `IntelligenceModuleName`, a closed union of
 * the Stage-B intelligence modules with a feature flag *and* a kill switch
 * each. Share intake is an ingress, not an intelligence module, and widening
 * that union would put a route in a registry whose contract test
 * (`tests/contract/intelligenceModuleBoundaries.test.ts`) is about something
 * else. One variable, read per request, says what it means.
 *
 * ── Read every request ───────────────────────────────────────────
 *
 * Never cached. Turning it off has to hold on the next request rather than
 * after a restart — that is the only property a switch like this has.
 */

/** The environment variable. Unset is off. */
export const SHARE_INTAKE_FLAG = 'SHARE_INTAKE_ENABLED';

export function shareIntakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[SHARE_INTAKE_FLAG] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** A `Response` when share intake is off, `undefined` when the route may run. */
export function shareDisabledResponse(env: NodeJS.ProcessEnv = process.env): Response | undefined {
  if (shareIntakeEnabled(env)) return undefined;
  return Response.json(
    { success: false, error: 'not found', reason: 'feature_unavailable' },
    { status: 404 },
  );
}
