import { readRuntimeControls } from '../../src/contracts/v1/runtimeControls';
import {
  createPilotAuditEvent,
  decidePilotExposure,
  parseClosedPilotAllowlist,
  requirePilotParticipantId,
  type PilotExposureDecision,
  type PilotTrustState,
} from './closedPilotControls';
import { getPilotTrustStore } from './pilotTrustStore';

export interface PilotAccessResult {
  decision: PilotExposureDecision;
  trust: PilotTrustState | null;
}

export function resolvePilotAccess(participantId: string, at: string, audit = true): PilotAccessResult {
  requirePilotParticipantId(participantId);
  const allowlist = parseClosedPilotAllowlist(process.env.MAYBESITTER_CLOSED_PILOT_IDS);
  if (!allowlist.has(participantId)) {
    return { decision: { allowed: false, reason: 'not_allowlisted' }, trust: null };
  }

  const store = getPilotTrustStore();
  const trust = store.getOrCreate(participantId, at);
  const controls = readRuntimeControls();
  const decision = decidePilotExposure({
    participantId,
    allowlist,
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
    const allowlist = parseClosedPilotAllowlist(process.env.MAYBESITTER_CLOSED_PILOT_IDS);
    if (!allowlist.has(participantId)) return 'essential';
    return getPilotTrustStore().getOrCreate(participantId, at).analyticsConsent ? 'granted' : 'essential';
  } catch {
    return 'essential';
  }
}
