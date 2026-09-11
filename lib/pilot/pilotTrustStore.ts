/**
 * The pilot trust record, on durable storage (UC-1.0b, #141).
 *
 * ── Why the singleton had to go ──────────────────────────────────
 *
 * This module used to load one JSON file into a process-wide object at first
 * use and keep it there. Every instance therefore held its own copy: a
 * participant who revoked consent on instance A stayed consented on instance B
 * until B restarted. That is not a caching inefficiency, it is a privacy
 * defect — a revocation that does not take effect everywhere is not a
 * revocation. Every function below reads storage on every call, so a revoke
 * lands on the next read anywhere.
 *
 * Audit events and incidents were unbounded arrays inside that same file, so
 * appending one rewrote the whole document. They are collections now:
 * `users/{uid}/auditEvents/{id}` per participant, and an operator-only
 * top-level `incidents/{incidentId}`.
 *
 * Audit ids sort by time, so a plain listing reads back in the order it was
 * written without an index or an `orderBy`.
 */
import { randomUUID } from 'node:crypto';
import {
  applyPilotTrustAction,
  createPilotAuditEvent,
  createPilotTrustIncident,
  createPilotTrustState,
  requirePilotParticipantId,
  requirePilotTrustState,
  type PilotAuditEvent,
  type PilotTrustAction,
  type PilotTrustIncident,
  type PilotTrustState,
} from './closedPilotControls';
import {
  AUDIT_EVENTS,
  getStorage,
  INCIDENTS,
  requireUserId,
  sortableDocId,
  userCol,
  userDoc,
} from '../storage';
import { newUserDocument, type UserDocument } from '../storage/userDocument';

type TrustUser = UserDocument<PilotTrustState>;

function auditDocId(event: PilotAuditEvent): string {
  return sortableDocId(event.occurredAt, randomUUID());
}

/**
 * The participant's trust record, created on first sight.
 *
 * Transactional create-if-absent: two requests arriving together for a
 * participant nobody has seen before produce one record, not two, and never a
 * record that lost one of the two writes.
 */
export async function getOrCreateTrust(participantId: string, at: string): Promise<PilotTrustState> {
  requirePilotParticipantId(participantId);
  requireUserId(participantId);
  return getStorage().runTransaction(async (tx) => {
    const user = await tx.get<TrustUser>(userDoc(participantId));
    if (user?.trust) return requirePilotTrustState(user.trust);
    const created = createPilotTrustState(participantId, at);
    if (user) tx.merge<TrustUser>(userDoc(participantId), { trust: created, updatedAt: at });
    else tx.set<TrustUser>(userDoc(participantId), { ...newUserDocument(at), trust: created });
    return created;
  });
}

/**
 * Apply one trust action to the record as it is *now*.
 *
 * The read and the write are in one transaction, so two consent changes racing
 * cannot both start from the same record and lose one of them.
 */
export async function applyTrustAction(participantId: string, action: PilotTrustAction): Promise<PilotTrustState> {
  requirePilotParticipantId(participantId);
  return getStorage().runTransaction(async (tx) => {
    const user = await tx.get<TrustUser>(userDoc(participantId));
    const current = user?.trust
      ? requirePilotTrustState(user.trust)
      : createPilotTrustState(participantId, action.at);
    const updated = applyPilotTrustAction(current, action);
    if (user) tx.merge<TrustUser>(userDoc(participantId), { trust: updated, updatedAt: action.at });
    else tx.set<TrustUser>(userDoc(participantId), { ...newUserDocument(action.at), trust: updated });
    return updated;
  });
}

/** Append-only: a fresh document id per event, so no append can overwrite another. */
export async function appendAudit(event: PilotAuditEvent): Promise<PilotAuditEvent> {
  const validated = createPilotAuditEvent(event);
  requireUserId(validated.participantId);
  await getStorage().set(
    `${userCol(validated.participantId, AUDIT_EVENTS)}/${auditDocId(validated)}`,
    validated,
  );
  return { ...validated };
}

export async function appendIncident(incident: PilotTrustIncident): Promise<PilotTrustIncident> {
  const validated = createPilotTrustIncident(incident);
  return getStorage().runTransaction(async (tx) => {
    const existing = await tx.get<PilotTrustIncident>(`${INCIDENTS}/${validated.incidentId}`);
    if (existing) throw new Error('incidentId already exists');
    tx.create<PilotTrustIncident>(`${INCIDENTS}/${validated.incidentId}`, validated);
    return { ...validated };
  });
}

export async function updateIncident(
  incidentId: string,
  updates: Pick<PilotTrustIncident, 'status' | 'containmentCode' | 'resolutionCode'>,
): Promise<PilotTrustIncident> {
  return getStorage().runTransaction(async (tx) => {
    const existing = await tx.get<PilotTrustIncident>(`${INCIDENTS}/${incidentId}`);
    if (!existing) throw new Error('incident not found');
    const updated = createPilotTrustIncident({ ...existing, ...updates });
    tx.set<PilotTrustIncident>(`${INCIDENTS}/${incidentId}`, updated);
    return updated;
  });
}

/** One participant's audit trail, oldest first. */
export async function listAuditEvents(participantId: string): Promise<PilotAuditEvent[]> {
  requireUserId(participantId);
  const rows = await getStorage().list<PilotAuditEvent>(userCol(participantId, AUDIT_EVENTS));
  return rows.map((row) => ({ ...row.data }));
}

/**
 * Every participant's audit trail, for the operator surface.
 *
 * A collection-group read rather than a per-participant loop, because the
 * operator log is a cross-participant view and iterating users would make it
 * cost one read per person in the pilot.
 */
export async function listAllAuditEvents(): Promise<PilotAuditEvent[]> {
  const rows = await getStorage().listGroup<PilotAuditEvent>(AUDIT_EVENTS);
  return rows.map((row) => ({ ...row.data }));
}

export async function listIncidents(): Promise<PilotTrustIncident[]> {
  const rows = await getStorage().list<PilotTrustIncident>(INCIDENTS);
  return rows.map((row) => ({ ...row.data }));
}
