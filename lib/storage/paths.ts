/**
 * Every document path this repo writes, built in one place (UC-1.0b, #141).
 *
 * ── Why a user id has its own pattern ────────────────────────────
 *
 * `requirePilotParticipantId` (lib/pilot/closedPilotControls) is lowercase-only
 * because a pilot id is minted by us. A Firebase uid is mixed-case and is
 * minted by Firebase, so the same pattern would reject every real account the
 * moment UC-1.0e (#144) lands. This one accepts both and rejects what actually
 * breaks a path: `/`, `.`, `..` and the empty string. It is a path check, not
 * an authorisation check — admission still belongs to the pilot controls.
 *
 * ── Free text never becomes a document id ────────────────────────
 *
 * An idempotency key or a scope key is caller-supplied text: it can contain a
 * slash, exceed the id length limit, or be `__proto__`. The id is the sha256 of
 * it and the raw value is stored in a field, so the document is still findable
 * and the path is still a path.
 */
import { createHash } from 'node:crypto';

export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Subcollections under `users/{uid}`, named once so a typo cannot split a tree. */
export const COMMITMENTS = 'commitments';
export const REMINDERS = 'reminders';
export const ESCALATION_STATES = 'escalationStates';
export const EVENTS = 'events';
export const RECOMMENDATION_ACTIONS = 'recommendationActions';
export const AUDIT_EVENTS = 'auditEvents';

/** Added by UC-1.0c (#142) as the remaining stores moved off local disk. */
export const MEMORY = 'memory';
export const FEEDBACK_EVENTS = 'feedbackEvents';
export const FEEDBACK_BASELINES = 'feedbackBaselines';
export const CONSENTS = 'consents';
export const STUDY_RESPONSES = 'studyResponses';
export const ALPHA_TRACES = 'alphaTraces';
export const ALPHA_FEEDBACK = 'alphaFeedback';
export const BEHAVIOR_FEEDBACK = 'behaviorFeedback';
export const PRESSURE_DELIVERY = 'pressureDelivery';
export const CLARIFICATIONS = 'clarifications';
export const ANALYTICS_EVENTS = 'analyticsEvents';
/** Capture proposals between proposing and confirming (#252). */
export const CAPTURE_PROPOSALS = 'captureProposals';
/** One document per UTC day: how many model calls this account has spent (#160). */
export const USAGE = 'usage';

/**
 * Every user-scoped subcollection, so account deletion can be *checked* rather
 * than remembered. `tests/storage/deletionCoverage.test.ts` seeds one document
 * in each and asserts `deleteTree('users/U')` leaves none — a new collection
 * added without appearing here is a collection deletion would silently miss.
 *
 * `jobs` is deliberately absent: it is a top-level operational collection, not
 * something inside a user's tree (see lib/scheduler/storageSchedulerStore).
 */
export const USER_SCOPED_COLLECTIONS = [
  COMMITMENTS,
  REMINDERS,
  ESCALATION_STATES,
  EVENTS,
  RECOMMENDATION_ACTIONS,
  AUDIT_EVENTS,
  MEMORY,
  FEEDBACK_EVENTS,
  FEEDBACK_BASELINES,
  CONSENTS,
  STUDY_RESPONSES,
  ALPHA_TRACES,
  ALPHA_FEEDBACK,
  BEHAVIOR_FEEDBACK,
  PRESSURE_DELIVERY,
  CLARIFICATIONS,
  ANALYTICS_EVENTS,
  CAPTURE_PROPOSALS,
  USAGE,
] as const;

/** Operator-only, outside every user tree. */
export const INCIDENTS = 'incidents';

/**
 * The service's own daily model spend, one document per UTC day (#160).
 *
 * Top-level and deliberately not under a uid: it is what MaybeSitter spent,
 * not what a person did, and nesting it in a tree would mean deleting an
 * account erased that day's global count.
 */
export const LLM_USAGE = 'llmUsage';

export const USERS = 'users';

export function requireUserId(id: unknown): string {
  if (typeof id !== 'string' || !USER_ID_PATTERN.test(id)) {
    throw new Error('userId must match /^[A-Za-z0-9_-]{1,128}$/');
  }
  return id;
}

export function userDoc(uid: string): string {
  return `${USERS}/${requireUserId(uid)}`;
}

export function userCol(uid: string, name: string): string {
  return `${userDoc(uid)}/${requireCollectionName(name)}`;
}

export function userSubDoc(uid: string, collection: string, docId: string): string {
  return `${userCol(uid, collection)}/${requireDocId(docId)}`;
}

/** The document id for a free-text key. The raw value belongs in a field. */
export function docIdForKey(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('a document key must be a non-empty string');
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * A uid for a store whose key is not yet a uid (UC-1.0c, #142).
 *
 * Several migrated stores are keyed by a `scopeId` or `participantId` that
 * predates Firebase auth: a conversation id, a session id, sometimes free text
 * a caller supplied. UC-1.0c's decision is that this key *becomes* the uid, but
 * `requireUserId` would reject anything with a `/`, a dot, a space or Arabic
 * text — and a store that throws on a legitimate existing scope id is worse
 * than one that hashes it.
 *
 * So: a key already shaped like a uid is used as-is, which keeps real
 * participant ids and Firebase uids readable in the console and keeps
 * `users/{uid}` meaning the same thing for them. Anything else becomes the
 * sha256 of itself, which is stable, collision-free in practice, and a valid
 * path segment. The raw key is stored in a field by every caller that uses
 * this, so the record stays findable.
 *
 * UC-1.0e (#144) makes every request carry a real uid, at which point the
 * hashing branch stops being reachable for live traffic.
 */
export function userIdForKey(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('a user key must be a non-empty string');
  }
  return USER_ID_PATTERN.test(raw) ? raw : docIdForKey(raw);
}

const COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function requireCollectionName(name: string): string {
  if (!COLLECTION_NAME.test(name)) throw new Error(`not a collection name: ${String(name)}`);
  return name;
}

/**
 * A document id we minted: a uuid, a sha256, a sortable audit id. Deliberately
 * narrower than Firestore allows, because everything this repo generates fits.
 */
const DOC_ID = /^[A-Za-z0-9_][A-Za-z0-9_\-.]{0,510}$/;

export function requireDocId(id: string): string {
  if (typeof id !== 'string' || !DOC_ID.test(id) || id === '.' || id === '..') {
    throw new Error(`not a document id: ${String(id)}`);
  }
  return id;
}

/**
 * A document id that sorts by time, so an append-only log reads back in the
 * order it was written without a Firestore index or an `orderBy`.
 */
export function sortableDocId(at: string, unique: string): string {
  const stamp = at.replace(/[^0-9A-Za-z]/g, '-');
  return requireDocId(`${stamp}_${unique}`.replace(/[^A-Za-z0-9_\-.]/g, '-'));
}

/** True for `a/b`, `a/b/c/d`; false for `a`, `a/b/c`. */
export function isDocumentPath(path: string): boolean {
  return segmentsOf(path).length % 2 === 0;
}

export function isCollectionPath(path: string): boolean {
  return segmentsOf(path).length % 2 === 1;
}

export function segmentsOf(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0) throw new Error('a storage path must be a non-empty string');
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw new Error(`not a storage path: ${path}`);
  }
  return segments;
}

export function requireDocumentPath(path: string): string {
  if (!isDocumentPath(path)) throw new Error(`not a document path (needs an even number of segments): ${path}`);
  return path;
}

export function requireCollectionPath(path: string): string {
  if (!isCollectionPath(path)) throw new Error(`not a collection path (needs an odd number of segments): ${path}`);
  return path;
}

/** The collection a document lives in: `users/u/commitments/c` → `users/u/commitments`. */
export function parentCollectionOf(documentPath: string): string {
  const segments = segmentsOf(requireDocumentPath(documentPath));
  return segments.slice(0, -1).join('/');
}

export function documentIdOf(documentPath: string): string {
  const segments = segmentsOf(requireDocumentPath(documentPath));
  return segments[segments.length - 1];
}

/** The last segment of a collection path: `users/u/commitments` → `commitments`. */
export function collectionIdOf(collectionPath: string): string {
  const segments = segmentsOf(requireCollectionPath(collectionPath));
  return segments[segments.length - 1];
}
