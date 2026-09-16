/**
 * One participant's domain state, on durable storage (UC-1.0b, #141).
 *
 * ── What this replaces, and why ──────────────────────────────────
 *
 * This module used to write `<data dir>/participants/<id>-state.json` and
 * serialise same-participant writes through an in-process `Map` of promise
 * queues. That lock is invisible to a second process: two Cloud Run instances
 * holding the same participant would each read, each apply, and each write the
 * whole file, and the later write would silently erase the earlier one. The
 * queue is gone; the mutual exclusion is now the storage transaction, which
 * every instance participates in.
 *
 * ── One document per entry ───────────────────────────────────────
 *
 * `users/{uid}/commitments/{id}` rather than one `DomainState` document,
 * because a single document tops out at 1 MiB and a person who keeps using the
 * product would eventually reach it. `writeDomainDiff` writes only the entries
 * that actually changed, so a transaction's write set is proportional to the
 * command, not to the size of the account.
 *
 * ── Transaction callbacks run more than once ─────────────────────
 *
 * Every callback below is re-run from the top when a transaction retries.
 * `applyDomainCommand` is pure, so re-running it is free. A caller passing a
 * `create` callback into `replayOrRecordParticipantDecision` must keep it pure
 * for the same reason — see the note on that function.
 */
import {
  applyCommand as applyDomainCommand,
  createEmptyDomainState,
  InvalidStateTransitionError,
  MissingEntityError,
  normalizeStoredCommitment,
  ValidationError,
  type Command,
  type Commitment,
  type DomainEvent,
  type DomainState,
  type EscalationState,
  type Reminder,
} from '../../../src/domain/stateMachine';
import {
  COMMITMENTS,
  docIdForKey,
  ESCALATION_STATES,
  EVENTS,
  getStorage,
  HARD_REMINDERS,
  PLAN_EVENTS,
  PLANS,
  RECOMMENDATION_ACTIONS,
  REMINDERS,
  requireDocId,
  requireUserId,
  STATS,
  userCol,
  userDoc,
  type StorageReader,
  type StorageTransaction,
} from '../../storage';
import { newUserDocument, type UserDocument } from '../../storage/userDocument';
import { readActivityStats, recordActivityEvents } from '../activity/activityStats';
import { commitmentValidator } from './commitmentValidator';
import { writeHardReminderIndexDiff } from '../reminders/hardReminderIndex';

export type ParticipantCommandResultType = 'applied' | 'noop' | 'rejected' | 'invalid_transition';

export interface ParticipantCommandResult {
  result: ParticipantCommandResultType;
  newState: DomainState;
  events: DomainEvent[];
}

/**
 * What the caller believed it was editing (UC-1.4, #148).
 *
 * The validator is what the client received as an `ETag` on the single
 * commitment read (see `commitmentValidator`). It is checked against the state
 * this transaction loaded, so the comparison and the write commit together: a
 * pre-read followed by a separate write would leave exactly the window this
 * exists to close.
 */
export interface CommitmentPrecondition {
  commitmentId: string;
  /** The opaque validator, from `commitmentValidator` — not a bare timestamp. */
  validator: string;
}

/**
 * The commitment moved since the caller read it.
 *
 * Carries the state that is actually current, because the client needs to show
 * it rather than simply be refused — two devices editing one commitment is the
 * normal case this feature exists for, not an error.
 */
export class StaleCommitmentError extends Error {
  constructor(readonly current: Commitment) {
    super('stale_commitment');
    this.name = 'StaleCommitmentError';
  }
}

interface RecommendationDecisionRecord {
  idempotencyKey: string;
  fingerprint: string;
  response: unknown;
  createdAt: string;
}

/** Every subcollection holding this participant's own data. Deletion walks it. */
const PARTICIPANT_COLLECTIONS = [
  COMMITMENTS,
  // The index of their Must reminders goes with the commitments it indexes (#198).
  HARD_REMINDERS,
  REMINDERS,
  ESCALATION_STATES,
  EVENTS,
  RECOMMENDATION_ACTIONS,
  // The activity counters go with a wipe (UC-3.15, #201). A Moment survives
  // deleting the *item* it came from, which is what #201 asks for; it does not
  // survive the person deleting their data, which is a different request and
  // the one where leaving a count behind would be retention nobody asked for.
  STATS,
  // The daily plan and its ledger (#194). Activity reads the ledger back for
  // history, days with a plan and a legacy first-plan Moment (#201), so a wipe
  // that left it would resurrect all three on an account that asked to be
  // emptied.
  PLANS,
  PLAN_EVENTS,
] as const;

function cloneState(state: DomainState): DomainState {
  return JSON.parse(JSON.stringify(state)) as DomainState;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key) &&
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * A domain entity's id as a document id. Entity ids are ours (uuids, and the
 * ids a capture assigns), but an id that is not a legal document id is hashed
 * rather than rejected: the entity carries its own id in a field, so nothing
 * downstream reads the document id back.
 */
function entityDocId(id: string): string {
  try {
    return requireDocId(id);
  } catch {
    return docIdForKey(id);
  }
}

function entryPath(uid: string, collection: string, id: string): string {
  return `${userCol(uid, collection)}/${entityDocId(id)}`;
}

/** Where one commitment is stored, for a reader that needs exactly one (#198). */
export function commitmentDocPath(uid: string, commitmentId: string): string {
  return entryPath(requireUserId(uid), COMMITMENTS, commitmentId);
}

/** The three domain subcollections, assembled back into a `DomainState`. */
export async function loadDomainState(reader: StorageReader, uid: string): Promise<DomainState> {
  requireUserId(uid);
  const [commitments, reminders, escalationStates] = await Promise.all([
    reader.list<Commitment>(userCol(uid, COMMITMENTS)),
    reader.list<Reminder>(userCol(uid, REMINDERS)),
    reader.list<EscalationState>(userCol(uid, ESCALATION_STATES)),
  ]);
  const state = createEmptyDomainState();
  // Completed, not copied (#185). A document written before a field existed is
  // missing it, and everything downstream — `commitmentToMobileDto` most of all
  // — passes `timeSpec` through verbatim. This is the one place a stored
  // commitment becomes a domain one, so it is the one place the repair belongs.
  for (const { data } of commitments) state.commitments[data.id] = normalizeStoredCommitment(data);
  for (const { data } of reminders) state.reminders[data.id] = data;
  for (const { data } of escalationStates) state.escalationStates[data.commitmentId] = data;
  return state;
}

type EntryMap = Record<string, { id?: string; commitmentId?: string }>;

function diffCollection(
  tx: StorageTransaction,
  uid: string,
  collection: string,
  before: EntryMap,
  after: EntryMap,
): void {
  for (const [key, value] of Object.entries(after)) {
    if (!deepEqual(before[key], value)) tx.set(entryPath(uid, collection, key), value);
  }
  for (const key of Object.keys(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) tx.delete(entryPath(uid, collection, key));
  }
}

/**
 * The writes one committed domain transition implies: changed entries, removed
 * entries, the events it produced, and the user document's version.
 *
 * Must be called after every read the transaction needs, because Firestore
 * refuses a read issued after a write and both adapters enforce that.
 */
export function writeDomainDiff(
  tx: StorageTransaction,
  uid: string,
  before: DomainState,
  after: DomainState,
  events: readonly DomainEvent[],
  user: UserDocument | null,
  at: string,
): void {
  requireUserId(uid);
  diffCollection(tx, uid, COMMITMENTS, before.commitments, after.commitments);
  diffCollection(tx, uid, REMINDERS, before.reminders, after.reminders);
  diffCollection(tx, uid, ESCALATION_STATES, before.escalationStates, after.escalationStates);
  // The Must-reminder index (UC-3.12b, #198), in the same commit as the
  // commitment it describes — this is the one place every commitment write
  // passes through, so it is the one place the index cannot be forgotten.
  writeHardReminderIndexDiff(tx, uid, before.commitments, after.commitments, user, at);

  for (const event of events) {
    // `create`, never `set`: the event log is append-only, and an id that
    // already exists is a defect worth a failed transaction.
    tx.create(entryPath(uid, EVENTS, event.id), { ...event, recordedAt: at });
  }

  const version = { domainVersion: (user?.domainVersion ?? 0) + 1, updatedAt: at };
  if (user) tx.merge<UserDocument>(userDoc(uid), version);
  else tx.set<UserDocument>(userDoc(uid), { ...newUserDocument(at), ...version });
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function getParticipantStateSnapshot(participantId: string): Promise<DomainState> {
  return loadDomainState(getStorage(), participantId);
}

export async function readParticipantState(participantId: string): Promise<DomainState> {
  return getParticipantStateSnapshot(participantId);
}

export async function persistParticipantState(participantId: string, state: DomainState): Promise<DomainState> {
  requireUserId(participantId);
  const at = nowIso();
  return getStorage().runTransaction(async (tx) => {
    const [user, before] = await Promise.all([
      tx.get<UserDocument>(userDoc(participantId)),
      loadDomainState(tx, participantId),
    ]);
    writeDomainDiff(tx, participantId, before, state, [], user, at);
    return cloneState(state);
  });
}

export async function applyParticipantCommands(
  participantId: string,
  commands: readonly Command[],
): Promise<{ state: DomainState }> {
  requireUserId(participantId);
  const at = nowIso();
  return getStorage().runTransaction(async (tx) => {
    const [user, before, stats] = await Promise.all([
      tx.get<UserDocument>(userDoc(participantId)),
      loadDomainState(tx, participantId),
      readActivityStats(tx, participantId),
    ]);
    let candidate = before;
    const events: DomainEvent[] = [];
    for (const command of commands) {
      const transition = applyDomainCommand(candidate, command);
      candidate = transition.newState;
      events.push(...transition.events);
    }
    writeDomainDiff(tx, participantId, before, candidate, events, user, at);
    recordActivityEvents(tx, participantId, stats, events);
    return { state: cloneState(candidate) };
  });
}

function noopResult(state: DomainState, events: DomainEvent[] = []): ParticipantCommandResult {
  return { result: 'noop', newState: cloneState(state), events };
}

function rejectedResult(state: DomainState): ParticipantCommandResult {
  return { result: 'rejected', newState: cloneState(state), events: [] };
}

function invalidTransitionResult(state: DomainState): ParticipantCommandResult {
  return { result: 'invalid_transition', newState: cloneState(state), events: [] };
}

export async function applyParticipantCommand(
  participantId: string,
  command: Command,
  precondition?: CommitmentPrecondition,
): Promise<ParticipantCommandResult> {
  requireUserId(participantId);
  const at = nowIso();
  return getStorage().runTransaction(async (tx) => {
    const [user, before, stats] = await Promise.all([
      tx.get<UserDocument>(userDoc(participantId)),
      loadDomainState(tx, participantId),
      readActivityStats(tx, participantId),
    ]);
    // Inside the transaction, against the state it just read. A commitment that
    // moves between this check and the commit moves the version the transaction
    // recorded, so the transaction retries and checks again.
    //
    // A commitment that is absent is left to the command: it fails as a missing
    // entity, which the route answers 404, and that is a truer answer than
    // "stale".
    if (precondition) {
      const current = before.commitments[precondition.commitmentId];
      if (current && commitmentValidator(current) !== precondition.validator) throw new StaleCommitmentError(current);
    }
    try {
      const transition = applyDomainCommand(before, command);
      if (!transition.didChange) return noopResult(before, transition.events);
      writeDomainDiff(tx, participantId, before, transition.newState, transition.events, user, at);
      recordActivityEvents(tx, participantId, stats, transition.events);
      return {
        result: 'applied' as const,
        newState: cloneState(transition.newState),
        events: transition.events,
      };
    } catch (error) {
      // Distinguished from `noop`: completing an already-completed commitment
      // is a refusal the client should see, not a silent success. It used to
      // return the unchanged commitment with HTTP 200 (#148).
      if (error instanceof InvalidStateTransitionError) return invalidTransitionResult(before);
      if (error instanceof MissingEntityError || error instanceof ValidationError) return rejectedResult(before);
      throw error;
    }
  });
}

/**
 * This participant's domain data, the event log and the recorded decisions.
 *
 * The `users/{uid}` document itself stays: it carries the trust record, and a
 * deletion that removed it would turn "this participant deleted their data"
 * back into "this participant has never been seen", which is the difference
 * between a refusal reading `deleted` and reading `consent_required`.
 */
export async function deleteParticipantDomainState(participantId: string): Promise<void> {
  requireUserId(participantId);
  const at = nowIso();
  await getStorage().runTransaction(async (tx) => {
    const user = await tx.get<UserDocument>(userDoc(participantId));
    const listings = await Promise.all(
      PARTICIPANT_COLLECTIONS.map((collection) => tx.list<unknown>(userCol(participantId, collection))),
    );
    PARTICIPANT_COLLECTIONS.forEach((collection, index) => {
      for (const { id } of listings[index]) tx.delete(`${userCol(participantId, collection)}/${id}`);
    });
    const version = { domainVersion: (user?.domainVersion ?? 0) + 1, updatedAt: at };
    if (user) tx.merge<UserDocument>(userDoc(participantId), version);
    else tx.set<UserDocument>(userDoc(participantId), { ...newUserDocument(at), ...version });
  });
}

/**
 * Record a decision once, or replay the recorded one.
 *
 * **`create` must be pure.** It runs inside a storage transaction, and a
 * transaction retries: a callback that emits an analytics event or sends a
 * notification performs that effect once per attempt. Build the value here and
 * do the effect after this function returns, gated on `replayed === false`.
 */
/**
 * A capture confirmation's commands and its claim, committed together (#148).
 *
 * #252 made the proposal durable, so a confirm routed to a second instance can
 * find it. That is not yet exactly-once: two confirms of the same proposal
 * arriving together both read "not yet confirmed", both persist, and the second
 * write-back overwrites the first — two sets of commitments from one tap.
 *
 * The fix is that the claim *is* the write. The confirmed result is recorded on
 * the proposal in the same transaction that writes the commitments, so the two
 * cannot disagree: whichever transaction commits second reads the first one's
 * result and replays it instead of persisting again.
 *
 * `commands` must be pure to re-run, like every transaction callback here.
 */
export async function commitCaptureConfirmation<T>(
  participantId: string,
  proposalPath: string,
  commands: readonly Command[],
  idempotencyKey: string,
  result: T,
): Promise<{ replayed: boolean; result: T }> {
  requireUserId(participantId);
  const at = nowIso();
  return getStorage().runTransaction(async (tx) => {
    const [proposal, user, before, stats] = await Promise.all([
      tx.get<{ confirmedResult?: T; idempotencyKey?: string }>(proposalPath),
      tx.get<UserDocument>(userDoc(participantId)),
      loadDomainState(tx, participantId),
      readActivityStats(tx, participantId),
    ]);

    // Already confirmed, by an earlier request or by one that committed while
    // this transaction was reading. Either way the commitments exist and this
    // must not create a second set.
    if (proposal?.confirmedResult !== undefined) {
      return { replayed: true, result: proposal.confirmedResult };
    }

    let candidate = before;
    const events: DomainEvent[] = [];
    for (const command of commands) {
      const transition = applyDomainCommand(candidate, command);
      candidate = transition.newState;
      events.push(...transition.events);
    }
    writeDomainDiff(tx, participantId, before, candidate, events, user, at);
    recordActivityEvents(tx, participantId, stats, events);
    tx.merge<{ confirmedResult: T; idempotencyKey: string }>(proposalPath, { confirmedResult: result, idempotencyKey });
    return { replayed: false, result };
  });
}

/**
 * A decision already recorded under this key, if there is one.
 *
 * Read separately from `replayOrRecordParticipantDecision` because the caller
 * has to answer the replay *before* it re-validates the proposal. A decision
 * with effects changes the world — `done` completes the commitment — so the
 * proposal it was made against is legitimately stale the moment it succeeds.
 * Checking staleness first would answer a network retry with 409, leaving the
 * client unable to tell whether its decision landed.
 */
export async function findParticipantDecision<T>(
  participantId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<T | null> {
  requireUserId(participantId);
  const path = `${userCol(participantId, RECOMMENDATION_ACTIONS)}/${docIdForKey(idempotencyKey)}`;
  const existing = await getStorage().get<RecommendationDecisionRecord>(path);
  if (!existing) return null;
  if (existing.fingerprint !== fingerprint) throw new Error('idempotencyKey body mismatch');
  return existing.response as T;
}

export async function replayOrRecordParticipantDecision<T>(
  participantId: string,
  idempotencyKey: string,
  fingerprint: string,
  create: () => T,
): Promise<{ replayed: boolean; response: T }> {
  requireUserId(participantId);
  const path = `${userCol(participantId, RECOMMENDATION_ACTIONS)}/${docIdForKey(idempotencyKey)}`;
  const createdAt = nowIso();
  return getStorage().runTransaction(async (tx) => {
    const existing = await tx.get<RecommendationDecisionRecord>(path);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('idempotencyKey body mismatch');
      return { replayed: true, response: existing.response as T };
    }
    const response = create();
    tx.create<RecommendationDecisionRecord>(path, { idempotencyKey, fingerprint, response, createdAt });
    return { replayed: false, response };
  });
}
