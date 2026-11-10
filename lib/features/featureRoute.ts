/**
 * The gate as an add-on route uses it, at the point the route would start
 * spending or showing the add-on.
 *
 * ── The same 404 a switched-off module answers ───────────────────
 *
 * A locked add-on answers exactly what `moduleDisabledResponse` answers —
 * 404 `reason: 'feature_unavailable'` — because every installed app already
 * hides that surface on it (`FeatureUnavailableError`). An app that has never
 * heard of add-ons degrades the same way a new one does. The extra `feature`
 * field tells a new app which add-on to offer.
 *
 * A spent budget is not answered here: the model providers refuse that call
 * with the monthly quota (`cost_cap:user_monthly`), which the route's existing
 * quota handling already turns into words. An unreadable gate is a 503: the
 * server does not know, which is not the same as "you do not have it".
 */
import type { FeatureId } from './catalog';
import { decideFeature, refuses, type GateOptions } from './featureGate';

export async function featureLockedResponse(
  uid: string,
  feature: FeatureId,
  options: GateOptions = {},
): Promise<Response | undefined> {
  const decision = await decideFeature(uid, feature, options);
  if (!refuses(decision)) return undefined;
  if (decision.reason === 'not_entitled' || decision.reason === 'user_off') {
    return Response.json(
      { success: false, error: 'not found', reason: 'feature_unavailable', feature },
      { status: 404 },
    );
  }
  if (decision.reason === 'gate_unavailable') {
    return Response.json(
      { success: false, error: 'service unavailable', reason: 'feature_gate_unavailable' },
      { status: 503 },
    );
  }
  return undefined;
}
