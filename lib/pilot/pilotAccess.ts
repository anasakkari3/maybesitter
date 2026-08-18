import { readRuntimeControls } from '../../src/contracts/v1/runtimeControls';
import {
  createPilotAuditEvent,
  decidePilotExposure,
  parseClosedPilotAllowlist,
  requirePilotParticipantId,
  type PilotExposureDecision,
  type PilotTrustState,
} from './closedPilotControls';
import { isAlphaParticipant } from './alphaControls';
import { getPilotTrustStore } from './pilotTrustStore';

export interface PilotAccessResult {
  decision: PilotExposureDecision;
  trust: PilotTrustState | null;
}

/**
 * Membership check: closed-pilot allowlist (25–40, V03 contract) OR the
 * explicit trusted-alpha allowlist (1–10, internal-only). The closed-pilot
 * parser is deliberately strict and throws when fewer than 25 IDs are set;
 * that throw is tolerated here ONLY when an alpha allowlist is configured,
 * so a small trusted-alpha run can start before the real pilot fills out.
 */
function isAllowlisted(participantId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isAlphaParticipant(participantId, env)) return true;
  try {
    return parseClosedPilotAllowlist(env.MAYBESITTER_CLOSED_PILOT_IDS).has(participantId);
  } catch {
    return false;
  }
}

export function resolvePilotAccess(participantId: string, at: string, audit = true): PilotAccessResult {
  requirePilotParticipantId(participantId);
  if (!isAllowlisted(participantId)) {
    return { decision: { allowed: false, reason: 'not_allowlisted' }, trust: null };
  }

  const store = getPilotTrustStore();
  const trust = store.getOrCreate(participantId, at);
  const controls = readRuntimeControls();
  const decision = decidePilotExposure({
    participantId,
    // Membership was already admitted (closed OR alpha); expose the
    // participant to their own exposure decision.
    allowlist: new Set([participantId]),
    trust,
    featureEnabled: controls.featureFlags.recommendation,
    killSwitchActive: controls.killSwitches.recommendation,
  });

  if (audit) {
    store.appendAudit(createPilotAuditEvent({
      version: 'v1',
      eventType: 'exposure_checked',
      participantId,
      occurredAt: at,
      outcome: decision.allowed ? 'allowed' : 'blocked',
      reasonCode: decision.reason,
    }));
  }
  return { decision, trust };
}

/**
 * Preserves the reviewed V02 consent behavior outside a configured pilot. Once
 * pilot exposure is configured (or recommendation is enabled), client claims
 * are ignored and consent is derived from the durable trust record.
 */
export function resolvePilotAnalyticsConsent(
  participantId: string,
  requested: 'granted' | 'essential',
  at = new Date().toISOString(),
): 'granted' | 'essential' {
  const controls = readRuntimeControls();
  const pilotMode = process.env.MAYBESITTER_CLOSED_PILOT_IDS !== undefined || controls.featureFlags.recommendation;
  if (!pilotMode) return requested;
  try {
    requirePilotParticipantId(participantId);
    if (!isAllowlisted(participantId)) return 'essential';
    return getPilotTrustStore().getOrCreate(participantId, at).analyticsConsent ? 'granted' : 'essential';
  } catch {
    return 'essential';
  }
}
