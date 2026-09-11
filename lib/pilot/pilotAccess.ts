/**
 * What one signed-in user is currently exposed to (UC-1.0e, #144).
 *
 * ── Membership is not a question any more ────────────────────────
 *
 * This module used to begin with `isAllowlisted`: a 25–40 entry closed-pilot
 * roster OR a 1–10 entry trusted-alpha roster, both read from the environment,
 * and a refusal called `not_allowlisted`. Anyone who signs in with Apple,
 * Google or email is a user now, so the whole membership layer is gone along
 * with the two environment variables that configured those rosters.
 *
 * What is left is what was always about the person: their trust record and the
 * runtime controls. The reasons this can return are therefore
 * `deleted | revoked | kill_switch_active | feature_disabled | quiet_mode |
 * consent_required | authorized`, and never `not_allowlisted`.
 *
 * Identity itself is checked before any of this, by `requireMobileUser`
 * against a Google signature. This function answers "what may this user see",
 * never "is this really them".
 */
import { readRuntimeControls } from '../../src/contracts/v1/runtimeControls';
import {
  createPilotAuditEvent,
  decidePilotExposure,
  requirePilotParticipantId,
  type PilotExposureDecision,
  type PilotTrustState,
} from './closedPilotControls';
import { appendAudit, getOrCreateTrust, readTrust } from './pilotTrustStore';

export interface UserAccessResult {
  decision: PilotExposureDecision;
  trust: PilotTrustState | null;
}

/**
 * Async since UC-1.0b (#141): the trust record lives in durable storage, read
 * on every call rather than held in a per-instance copy. That is what makes a
 * revocation on one instance visible on the next read from any other.
 */
export async function resolveUserAccess(uid: string, at: string, audit = true): Promise<UserAccessResult> {
  requirePilotParticipantId(uid);

  const trust = await getOrCreateTrust(uid, at);
  const controls = readRuntimeControls();
  const decision = decidePilotExposure({
    trust,
    featureEnabled: controls.featureFlags.recommendation,
    killSwitchActive: controls.killSwitches.recommendation,
  });

  if (audit) {
    await appendAudit(createPilotAuditEvent({
      version: 'v1',
      eventType: 'exposure_checked',
      participantId: uid,
      occurredAt: at,
      outcome: decision.allowed ? 'allowed' : 'blocked',
      reasonCode: decision.reason,
    }));
  }
  return { decision, trust };
}

/**
 * Analytics consent, derived from the trust record and from nothing else.
 *
 * The client's `consent` field is not an input. It used to be, outside a
 * configured pilot — a caller could simply claim `granted` — and the pilot
 * check that suppressed the claim was itself conditioned on an environment
 * variable that no longer exists. A claim is not a consent, so the answer is
 * the stored record or `essential`.
 *
 * The read is deliberately non-creating: `analyticsContextFrom` is reachable
 * from legacy routes that pass arbitrary caller-supplied ids, and creating a
 * `users/{uid}` document for each of those would litter storage with records
 * for people who do not exist.
 */
export async function resolvePilotAnalyticsConsent(
  uid: string,
  _requested: 'granted' | 'essential',
  _at = new Date().toISOString(),
): Promise<'granted' | 'essential'> {
  try {
    requirePilotParticipantId(uid);
    return (await readTrust(uid))?.analyticsConsent ? 'granted' : 'essential';
  } catch {
    return 'essential';
  }
}
