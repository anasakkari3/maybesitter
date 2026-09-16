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
/**
 * What the user answered to a next step (UC-2.9, #170).
 *
 * Its own collection, not `events`. `events` is the domain log: append-only,
 * replayed into `DomainState` by the reducer, and a record it does not know is
 * a record the reducer has to skip. And not `feedbackEvents` either — that is
 * the behaviour-learning ledger with its own outcomes, baselines and
 * revocation, and two ledgers sharing one collection is how a revoke on one
 * starts meaning something to the other.
 */
export const NEXT_STEP_DECISIONS = 'nextStepDecisions';
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
/**
 * What a person answered when the capture asked its one question (UC-2.5,
 * #165).
 *
 * Its own collection for the same reason `nextStepDecisions` has one. `events`
 * is the domain log: it is written only inside a domain transaction, every row
 * in it is a `DomainEvent` the reducer produced, and a clarification answer is
 * none of those — the commitment it is about does not exist yet, so there is no
 * aggregate for it to belong to. And not `clarifications` either: that holds
 * the *pending* question and is cleared when it is answered, which is exactly
 * the row this ledger has to outlive.
 *
 * The free text a user typed is never in here. Only which field was asked
 * about and whether they picked an option or wrote something.
 */
export const CLARIFICATION_EVENTS = 'clarificationEvents';
export const ANALYTICS_EVENTS = 'analyticsEvents';
/** Capture proposals between proposing and confirming (#252). */
export const CAPTURE_PROPOSALS = 'captureProposals';
/**
 * Self-description suggestions between proposing and confirming (#168).
 *
 * Separate from `captureProposals` because the two hold different things and
 * expire for different reasons — and because a self-description's suggestions
 * are claims about a person, which should be findable and deletable as their
 * own category rather than mixed in with commitments.
 *
 * The raw description is never in here. Only the suggestions derived from it.
 */
export const PROFILE_PROPOSALS = 'profileProposals';
/** One document per UTC day: how many model calls this account has spent (#160). */
export const USAGE = 'usage';
/**
 * One document per local day: the plan the morning job built (UC-3.10a, #194).
 *
 * A proposal about time, keyed by the user's own calendar date. It is inside
 * the user tree because it is about one person's day and goes with the account
 * when the account goes.
 */
export const PLANS = 'plans';
/**
 * What was done to a plan, append-only (UC-3.10a, #194).
 *
 * Its own collection for the reason `nextStepDecisions` has one: `events` is the
 * domain log, replayed into `DomainState` by the reducer, and a plan is not an
 * aggregate the reducer knows. It holds a type, a date, a generation and the
 * plan's digest — no titles and no explanation text.
 */
export const PLAN_EVENTS = 'planEvents';

/**
 * Which event in the user's own phone calendar a commitment was written to
 * (UC-3.1, #185).
 *
 * Its own collection rather than a field on the commitment, for the reason
 * `nextStepDecisions` and `clarificationEvents` have their own. A commitment is
 * a domain aggregate replayed from `events` by the reducer, and where somebody's
 * iPhone filed a copy of it is not a domain fact: no command produces it, no
 * state transition depends on it, and a replay that had to skip it would be a
 * replay that could lose it. It is a pointer held *beside* the aggregate, keyed
 * by the commitment id, written by whichever installation owns the event.
 *
 * What is in a row: a calendar id, an event id, a content hash, a state and a
 * timestamp. No title, no notes, nothing read back out of the user's calendar.
 */
export const DEVICE_CALENDAR_LINKS = 'deviceCalendarLinks';

/**
 * Which calendars this account has connected for *reading* busy time
 * (UC-3.2, #186).
 *
 * One document per source — `device:{installationId}` today, a Google account
 * (UC-3.3, #187) or an ICS feed (UC-3.4, #188) later. It holds the kind, the
 * platform, the window the last sync covered and when it ran. It is the row the
 * Trust Center counts and the row "Disconnect" removes.
 *
 * A source id is free text as far as a path is concerned — `device:` contains a
 * colon, which `requireDocId` refuses — so the document id is `docIdForKey` of
 * it and the raw value is a field, exactly as the header above prescribes.
 */
export const CALENDAR_SOURCES = 'calendarSources';

/**
 * The busy intervals themselves (UC-3.2, #186).
 *
 * Beside `calendarSources` rather than nested inside it, which is a deliberate
 * departure from #186's sketch. The question every reader asks is "what is this
 * person busy with between these two instants", across *every* source at once;
 * nested, that is a collection-group query, and the only group query this
 * repo's storage seam offers spans the whole database rather than one user's
 * tree. Flat, it is a single user-scoped list, and #187 and #188 add a source
 * without touching the read at all.
 *
 * A row is six fields — a block id, its source, the source's kind, a start, an
 * end and whether it is all-day. There is no title, no notes, no location and
 * no attendee: `toBusyBlocks` on the phone drops them and this collection has
 * never had a column for one.
 */
export const BUSY_BLOCKS = 'busyBlocks';

/**
 * The activity counters behind the weekly Moments (UC-3.15, #201).
 *
 * A counter rather than a query over the user's items, because a Moment is a
 * fact about something that happened and deleting the commitment afterwards
 * must not unhappen it. `users/{uid}/stats/activity` is advanced in the very
 * transaction that appends the `commitment_completed` event, so the count and
 * the log cannot disagree; see lib/services/activity/activityStats.
 */
export const STATS = 'stats';

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
  NEXT_STEP_DECISIONS,
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
  CLARIFICATION_EVENTS,
  ANALYTICS_EVENTS,
  CAPTURE_PROPOSALS,
  PROFILE_PROPOSALS,
  USAGE,
  PLANS,
  PLAN_EVENTS,
  STATS,
  DEVICE_CALENDAR_LINKS,
  CALENDAR_SOURCES,
  BUSY_BLOCKS,
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
