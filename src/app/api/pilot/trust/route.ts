import { analyticsContextFrom } from '../../../../../lib/analytics/analyticsContext';
import { appendAnalyticsEvent } from '../../../../../lib/analytics/eventStore';
import { recordDataDeleted } from '../../../../../lib/analytics/loopAnalytics';
import {
  buildWhatMaybeSitterKnows,
  createPilotAuditEvent,
  requirePilotParticipantId,
  type PilotTrustAction,
} from '../../../../../lib/pilot/closedPilotControls';
import { resolvePilotAccess } from '../../../../../lib/pilot/pilotAccess';
import { getPilotTrustStore } from '../../../../../lib/pilot/pilotTrustStore';
import { resetSingleUserAccount } from '../../../../../lib/services/appMetadataService';
import { getCommandServiceState } from '../../../../../lib/services/commandService';

export const dynamic = 'force-dynamic';

type ClientAction =
  | { type: 'grant_recommendation_consent' }
  | { type: 'set_recommendation_consent'; granted?: unknown }
  | { type: 'set_analytics_consent'; granted?: unknown }
  | { type: 'set_calendar_consent'; granted?: unknown }
  | { type: 'set_quiet_mode'; enabled?: unknown }
  | { type: 'revoke' }
  | { type: 'delete' };

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'pilot trust request failed';
  const status = /allowlist must contain|instance participant binding is required/.test(message) ? 503 : /not admitted/.test(message) ? 403 : 400;
  return Response.json({ error: message }, { status });
}

function participantIdFromUrl(request: Request): string {
  return new URL(request.url).searchParams.get('participantId') || '';
}

function requireAllowlisted(participantId: string): void {
  requirePilotParticipantId(participantId);
  const access = resolvePilotAccess(participantId, new Date().toISOString(), false);
  if (!access.trust) throw new Error('participant is not admitted to this pilot instance');
}

function clientAction(value: ClientAction, at: string): PilotTrustAction {
  switch (value?.type) {
    case 'grant_recommendation_consent': return { type: value.type, at };
    case 'set_recommendation_consent':
      if (typeof value.granted !== 'boolean') throw new Error('granted must be boolean');
      return { type: value.type, granted: value.granted, at };
    case 'set_analytics_consent':
      if (typeof value.granted !== 'boolean') throw new Error('granted must be boolean');
      return { type: value.type, granted: value.granted, at };
    case 'set_calendar_consent':
      if (typeof value.granted !== 'boolean') throw new Error('granted must be boolean');
      return { type: value.type, granted: value.granted, at };
    case 'set_quiet_mode':
      if (typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean');
      return { type: value.type, enabled: value.enabled, at };
    case 'revoke': return { type: value.type, at };
    case 'delete': return { type: value.type, at };
    default: throw new Error('unsupported pilot trust action');
  }
}

function view(participantId: string, now: string) {
  const access = resolvePilotAccess(participantId, now, false);
  if (!access.trust) throw new Error('participant is not allowlisted');
  const confirmedCommitmentCount = Object.values(getCommandServiceState().commitments)
    .filter((commitment) => Boolean(commitment.confirmedAt)).length;
  return {
    trust: access.trust,
    exposure: access.decision,
    whatKnows: buildWhatMaybeSitterKnows({ trust: access.trust, confirmedCommitmentCount }),
  };
}

export async function GET(request: Request) {
  try {
    const participantId = participantIdFromUrl(request);
    requireAllowlisted(participantId);
    return Response.json(view(participantId, new Date().toISOString()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { participantId?: string; action?: ClientAction };
    const participantId = body.participantId || '';
    requireAllowlisted(participantId);
    const at = new Date().toISOString();
    const action = clientAction(body.action as ClientAction, at);
    const store = getPilotTrustStore();
    const trust = store.apply(participantId, action);
    const eventType = action.type === 'set_quiet_mode'
      ? 'quiet_mode_changed'
      : action.type === 'revoke'
        ? 'revoked'
        : action.type === 'delete'
          ? 'data_deleted'
          : 'consent_changed';
    store.appendAudit(createPilotAuditEvent({
      version: 'v1', eventType, participantId, occurredAt: at, outcome: 'recorded', reasonCode: action.type,
    }));

    if (action.type === 'delete') {
      await resetSingleUserAccount();
      const analytics = analyticsContextFrom({ anonymousUserId: participantId, consent: 'essential' }, appendAnalyticsEvent);
      if (analytics) recordDataDeleted(analytics, 'all_commitments');
    }

    const confirmedCommitmentCount = Object.values(getCommandServiceState().commitments)
      .filter((commitment) => Boolean(commitment.confirmedAt)).length;
    const exposure = resolvePilotAccess(participantId, at, false).decision;
    return Response.json({
      trust,
      exposure,
      whatKnows: buildWhatMaybeSitterKnows({ trust, confirmedCommitmentCount }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
