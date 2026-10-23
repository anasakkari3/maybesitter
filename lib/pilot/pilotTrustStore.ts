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
import { AccountUnavailableError } from '../account/accountLiveness';
import { deletionTombstonePaths, storageMayHoldSharedTombstones } from '../account/deletionTombstone';
import type { StorageTransaction } from '../storage/storageAdapter';

type TrustUser = UserDocument<PilotTrustState>;

function auditDocId(event: PilotAuditEvent): string {
  return sortableDocId(event.occurredAt, randomUUID());
}

/**
 * The one way a trust record comes into being where there was none (#794).
 *
 * Both creators go through here — `getOrCreateTrust` on a uid's first request,
 * and `applyTrustAction` when the root is gone or has no trust record — so
 * there is one guarded create and not two that can drift. Before writing, it
 * reads every deletion tombstone path for the uid in the caller's transaction
 * and throws `AccountUnavailableError` if any exists: a deletion that swept the
 * root between an earlier check and this write must not get a fresh, live
 * trust record written behind it.
 *
 * `user` is the root as the transaction read it: merged into when present (it
 * may carry locale or timezone), created whole when absent.
 */
async function createTrustRecord(
  tx: StorageTransaction,
  participantId: string,
  user: TrustUser | null,
  trust: PilotTrustState,
  at: string,
  extra: Partial<TrustUser> = {},
): Promise<void> {
  const tombstones = deletionTombstonePaths(participantId, {
    sharedStorage: storageMayHoldSharedTombstones(),
  });
  for (const path of tombstones) {
    if (await tx.get(path)) throw new AccountUnavailableError();
  }
  if (user) tx.merge<TrustUser>(userDoc(participantId), { trust, updatedAt: at, ...extra });
  else tx.set<TrustUser>(userDoc(participantId), { ...newUserDocument(at), trust, ...extra });
}

/**
 * The participant's trust record, created on first sight.
 *
 * Transactional create-if-absent: two requests arriving together for a
 * participant nobody has seen before produce one record, not two, and never a
 * record that lost one of the two writes.
 *
 * ── A deleted account is never created again (#794) ──────────────
 *
 * The create path (`createTrustRecord`) reads the deletion tombstone in the
 * same transaction and throws `AccountUnavailableError` when there is one. Without it, a first
 * request that Firebase Auth admitted just before a whole deletion ran would
 * write a complete, live trust record behind the sweep. The tombstone is read
 * only when there is no trust record to return, so an existing account pays
 * nothing for it.
 */
export async function getOrCreateTrust(participantId: string, at: string): Promise<PilotTrustState> {
  requirePilotParticipantId(participantId);
  requireUserId(participantId);
  return getStorage().runTransaction(async (tx) => {
    const user = await tx.get<TrustUser>(userDoc(participantId));
    if (user?.trust) return requirePilotTrustState(user.trust);
    const created = createPilotTrustState(participantId, at);
    await createTrustRecord(tx, participantId, user, created, at);
    return created;
  });
}

/**
 * The trust record if there is one, without creating one if there is not.
 *
 * `getOrCreateTrust` is right where a request has already been authenticated
 * and the uid is real. It is wrong where the id is caller-supplied and may
 * belong to nobody — deriving analytics consent, for instance — because there
 * the create would write a `users/{uid}` document per bogus id. This read
 * answers "what did they consent to" without asserting that they exist.
 */
export async function readTrust(participantId: string): Promise<PilotTrustState | null> {
  requireUserId(participantId);
  const user = await getStorage().get<TrustUser>(userDoc(participantId));
  return user?.trust ? requirePilotTrustState(user.trust) : null;
}

/**
 * Apply one trust action to the record as it is *now*.
 *
 * The read and the write are in one transaction, so two consent changes racing
 * cannot both start from the same record and lose one of them.
 */
export async function applyTrustAction(
  participantId: string,
  requested: PilotTrustAction,
  options: {
    /**
     * Stamp the action when the transaction applies it, not when its request
     * began (Codex M6B-R12-004). For a change the person makes now: two quick
     * changes otherwise commit in reverse order, and the earlier-started one
     * is refused as backdated although it is a current action. The app sends
     * calendar-consent changes one after another; this keeps the server from
     * reordering what arrives.
     */
    readonly stampAtApply?: boolean;
    readonly now?: () => Date;
  } = {},
): Promise<PilotTrustState> {
  requirePilotParticipantId(participantId);
  return getStorage().runTransaction(async (tx) => {
    const user = await tx.get<TrustUser>(userDoc(participantId));
    const appliedAt = (options.now ?? (() => new Date()))().toISOString();
    const action: PilotTrustAction = options.stampAtApply && Date.parse(appliedAt) > Date.parse(requested.at)
      ? { ...requested, at: appliedAt }
      : requested;
    const current = user?.trust
      ? requirePilotTrustState(user.trust)
      : createPilotTrustState(participantId, action.at);
    const updated = applyPilotTrustAction(current, action);
    const calendarChanged = updated.calendarConsent !== current.calendarConsent;
    const calendarEpoch = (user?.calendarEpoch ?? 0) + (calendarChanged ? 1 : 0);
    const epoch = calendarChanged ? { calendarEpoch } : {};
    // No trust record to apply to means this write would create one: the root
    // is absent or trust-less, which is also what a deletion that swept in
    // after the caller's access check leaves (Q794-001). That goes through the
    // guarded create, never a bare write.
    if (user?.trust) tx.merge<TrustUser>(userDoc(participantId), { trust: updated, updatedAt: action.at, ...epoch });
    else await createTrustRecord(tx, participantId, user, updated, action.at, epoch);
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
