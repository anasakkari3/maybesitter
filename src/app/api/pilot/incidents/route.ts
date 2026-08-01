import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createPilotAuditEvent,
  createPilotTrustIncident,
  requirePilotParticipantId,
  type PilotTrustIncident,
} from '../../../../../lib/pilot/closedPilotControls';
import { getPilotTrustStore } from '../../../../../lib/pilot/pilotTrustStore';
import { resolvePilotAccess } from '../../../../../lib/pilot/pilotAccess';

export const dynamic = 'force-dynamic';

type ParticipantReport = Pick<PilotTrustIncident, 'participantId' | 'surface' | 'category'>;

function authorized(request: Request): boolean {
  const configured = process.env.MAYBESITTER_PILOT_ADMIN_TOKEN;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const configuredBytes = Buffer.from(configured || '');
  const suppliedBytes = Buffer.from(supplied);
  if (!configured || configuredBytes.length < 16 || suppliedBytes.length !== configuredBytes.length) return false;
  return timingSafeEqual(suppliedBytes, configuredBytes);
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: 'admin authorization required' }, { status: 401 });
  const store = getPilotTrustStore();
  return Response.json({ incidents: store.incidents(), auditEvents: store.auditEvents() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as ParticipantReport;
    requirePilotParticipantId(body.participantId);
    if (!resolvePilotAccess(body.participantId, new Date().toISOString(), false).trust) {
      return Response.json({ error: 'participant is not admitted to this pilot instance' }, { status: 403 });
    }
    const at = new Date().toISOString();
    const incident = createPilotTrustIncident({
      version: 'v1',
      incidentId: `incident-${randomUUID()}`,
      participantId: body.participantId,
      occurredAt: at,
      surface: body.surface,
      category: body.category,
      severity: 'medium',
      status: 'open',
      ownerId: process.env.MAYBESITTER_PILOT_INCIDENT_OWNER_ID || 'pilot_owner',
      containmentCode: 'reported_for_review',
      resolutionCode: null,
    });
    const store = getPilotTrustStore();
    store.appendIncident(incident);
    store.appendAudit(createPilotAuditEvent({
      version: 'v1', eventType: 'support_reported', participantId: body.participantId,
      occurredAt: at, outcome: 'recorded', reasonCode: body.category,
    }));
    return Response.json({ incidentId: incident.incidentId, status: incident.status }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'incident report rejected' }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return Response.json({ error: 'admin authorization required' }, { status: 401 });
  try {
    const body = await request.json() as Pick<PilotTrustIncident, 'incidentId' | 'status' | 'containmentCode' | 'resolutionCode'>;
    if (!body.incidentId || !body.status || !body.containmentCode || body.resolutionCode === undefined) {
      throw new Error('incidentId, status, containmentCode, and resolutionCode are required');
    }
    return Response.json(getPilotTrustStore().updateIncident(body.incidentId, {
      status: body.status, containmentCode: body.containmentCode, resolutionCode: body.resolutionCode,
    }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'incident update rejected' }, { status: 400 });
  }
}
