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
 * One document per notification-button tap the server has applied (UC-3.14,
 * #200), keyed by the phone's random `clientActionId`. The phone's outbox
 * replays a tap until it hears back; this is how the second delivery is
 * recognised. Ids, an action and a timestamp — no titles. `expiresAt` is a TTL
 * field (30 days, `infra/firestore-ttl.sh`): an outbox gives up long before.
 */
export const COMMITMENT_ACTION_RECEIPTS = 'commitmentActionReceipts';
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

/**
 * Suggestions a user answered "Not right" to (UC-3.16, #202).
 *
 * One document per rule, holding the fingerprint that was dismissed, so the
 * same claim is not offered again until what the rule would say changes. A
 * fingerprint names a window of the day read off the user's behaviour, which
 * makes this derived data about them: "delete everything" purges it, and it
 * goes with the account.
 */
export const MEMORY_DISMISSALS = 'memoryDismissals';
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
 * Which clubs a user follows (football fixtures MVP, Task 7).
 *
 * A subcollection under `users/{uid}`, one fixed document per account
 * (`userSubDoc(uid, FOOTBALL_FOLLOWS, 'clubs')`), because a follow list is
 * squarely one person's preference and belongs with the rest of their tree
 * when the account goes. It is not `consents`: a consent is a permission bit
 * the product checks before acting, and this is the acted-upon list itself —
 * the nightly sync reads it with `listGroup(FOOTBALL_FOLLOWS)` to learn which
 * clubs have any follower at all, which a permission collection has no reason
 * to be queried that way.
 */
export const FOOTBALL_FOLLOWS = 'footballFollows';

/**
 * The link between one user's commitment and the external fixture it came
 * from (football fixtures MVP, Task 8).
 *
 * Its own collection rather than a field on the commitment, for the same
 * reason `deviceCalendarLinks` is not a field either: it is a pointer *beside*
 * the aggregate, not a domain fact the reducer replays from `events`, and it
 * carries state the commitment itself must not — a `detachedAt` recording
 * that this user dismissed it, which the projection has to honour forever
 * after, even once the commitment it dismissed is gone. Not
 * `deviceCalendarLinks` either: that names an event in somebody's own phone
 * calendar, and this names a row in a provider's feed — conflating the two
 * would mean a dismissed match and a detached calendar event started
 * answering the same question.
 */
export const EXTERNAL_TASK_REFS = 'externalTaskRefs';

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
/**
 * What the user told us about their own money (#financial-v1).
 *
 * One document per field the user has stated or corrected, and one per bill
 * they typed in themselves. One row per field rather than an append-only
 * history, because the newest thing somebody said is the only one that decides
 * anything — and because deleting that row is the documented way to hand a
 * field back to the bank, which an append-only log has no gesture for.
 *
 * Nothing derived lives here. No balance, no buffer, no computed state: the
 * `FinancialState` is built at read time and never written down, so a stale
 * balance cannot sit in a database waiting to be believed. What a provider
 * observed is not here either — that is read through the connection each time.
 */
export const FINANCIAL_INPUTS = 'financialInputs';

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
 * The external calendar feeds this account subscribed to (UC-3.4, #188).
 *
 * One document per feed, keyed by a server-minted uuid. The feed URL is a
 * bearer secret (a Moodle export carries `authtoken=`), so it is here only as
 * a `fieldEncryption` blob bound to `fieldPurpose('ics-url', feedId)` — never
 * as text, never hashed, never returned. The rest is a label, a toggle, the
 * refresh bookkeeping (status, failures, ETag, next fetch) and two counts.
 */
export const ICS_FEEDS = 'icsFeeds';

/**
 * What a feed proposed, one document per deadline occurrence (UC-3.4, #188).
 *
 * Keyed by `sha256([feedId, UID, RECURRENCE-ID])`, so a refresh that sees the
 * same item again finds the same row rather than proposing it twice. It holds
 * the cleaned title, the due instant, the SEQUENCE/DTSTAMP it was last seen
 * with and the user's answer (pending, accepted, rejected, withdrawn) — not the
 * feed's UID in clear, not DESCRIPTION, nothing else the feed said.
 */
export const ICS_FEED_ITEMS = 'icsFeedItems';

/**
 * One document per installation this account has signed in on (UC-3.0b, #184).
 *
 * The FCM registration token lives here, keyed by an installation id the phone
 * mints once and keeps in its keychain. Keyed by installation rather than by
 * token because a token is rotated by Firebase without anybody asking: keying
 * on it would leave a dead document behind on every rotation, and the server
 * would keep pushing into it until FCM refused.
 *
 * A token is a device identifier, so the document is inside the user's tree
 * and goes with the account. It holds no email, no display name and no device
 * model — see `lib/push/deviceRegistry` for the closed field list.
 */
export const DEVICES = 'devices';

/**
 * One document per push already sent, as the idempotency lock (UC-3.0b, #184).
 *
 * `sendToUser` creates this document *before* it calls FCM, and a create that
 * fails because the document is there is what makes a second call with the
 * same `dedupeKey` a no-op. It is a lock rather than a log: it holds the key,
 * the kind and two instants, and never the text that was sent.
 *
 * `expiresAt` is the Firestore TTL field (seven days out). Note the spelling —
 * `expireAt` is a field nothing deletes.
 */
export const PUSH_LOG = 'pushLog';

/**
 * One document per Must commitment that may need a server backup push
 * (UC-3.12b, #198), `users/{uid}/hardReminders/{sha256(commitmentId)}`.
 *
 * An index, not a copy: the commitment id, the instant the reminder is for, a
 * status, and the receipt a phone uploaded saying it will ring locally. No
 * title. Maintained by `lib/services/reminders/hardReminderIndex` from the one
 * place every commitment write goes through (`writeDomainDiff`), and read by
 * the hard-reminders job through a collection-group query. `expiresAt` is its
 * TTL field.
 */
export const HARD_REMINDERS = 'hardReminders';

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
/**
 * A provider connection, one document per connection (#187, UC-3.3).
 *
 * Inside the user tree because a connection is one person's grant to one
 * provider, and it goes when the account goes. It holds no secret: the token
 * itself lives in `providerCredentials`, and this record only carries the
 * reference to it.
 */
export const PROVIDER_CONNECTIONS = 'providerConnections';

/**
 * The encrypted OAuth token set for a connection (#187, UC-3.3).
 *
 * Its own collection rather than a field on the connection so that a read of
 * the connection — which the UI and sync planning both do — never loads the
 * ciphertext at all. Deleting this one document revokes the grant locally
 * while leaving the connection record to say it was revoked.
 */
export const PROVIDER_CREDENTIALS = 'providerCredentials';

/**
 * An in-flight OAuth authorization, between the redirect and the callback.
 *
 * Holds the PKCE verifier, so it is a secret with a lifetime of minutes. It is
 * single-use: the callback consumes the document in a transaction, which is
 * what makes a replayed `state` fail rather than succeed twice.
 */
export const PROVIDER_OAUTH_STATES = 'providerOAuthStates';

/**
 * A watcher's definition plus its runtime baseline, one document per watcher
 * (#525). `users/{uid}/watchers/{watcherId}`.
 *
 * Inside the user tree because a watcher is one person's configuration — what
 * to watch, on which connection, with which effect — and goes with the
 * account. It holds no provider payload: a source is a provider name, a
 * connection id, a signal kind and an opaque `subjectRef`, and the runtime
 * baselines are digests and normalized numbers.
 */
export const WATCHERS = 'watchers';

/**
 * One document per watcher firing, append-only (#525).
 *
 * The history `GET /api/mobile/watchers/{id}/history` serves, and the firing
 * idempotency lock in one: the document id is `docIdForKey` of
 * `(watcherId, signalId)`, so the same signal delivered twice — overlapping
 * ticks, a retried sweep — can only be recorded, and therefore fired, once.
 * Content-free: ids, digests, reason codes and instants, never a title.
 */
export const WATCHER_EVENTS = 'watcherEvents';

/**
 * What a `propose_commitment` watcher produced: a proposal, never canonical
 * work (#525). One document per firing, keyed by a proposal id derived from
 * the firing's event id, so a duplicate firing proposes nothing twice.
 */
export const WATCHER_PROPOSALS = 'watcherProposals';

/**
 * What a `notify` watcher produced: a queued, content-free notification intent
 * (#525), one per firing. The monitoring surface (#527) renders and delivers
 * these; the engine deliberately does not invent per-provider copy.
 */
export const WATCHER_NOTIFICATIONS = 'watcherNotifications';

/**
 * The entry of the common state-change pipeline (#525 emitting; #523
 * consuming). A `replan_if_impacted` firing appends one `PlanningStateChange`
 * here; the impact evaluator reads them. No watcher touches a plan directly.
 */
export const PLANNING_STATE_CHANGES = 'planningStateChanges';

/**
 * Which vertical packs an account has switched on, one document per pack
 * (#528). `users/{uid}/packInstallations/{packId}`.
 *
 * Inside the user tree because it is one person's choice about one pack —
 * enabled or not, why, and the watchers that pack's templates produced. It
 * holds no provider payload and no derived claim: a pack id, a state, a
 * reason code, watcher ids and two instants. It is the only place the link
 * from a watcher back to *which* pack made it exists, which is what lets
 * disabling football leave athlete's watchers running.
 */
export const PACK_INSTALLATIONS = 'packInstallations';

/**
 * Things the user is considering or waiting on (#519).
 *
 * `users/{uid}/intentSeeds/{seedId}`. Its own collection rather than a status
 * on `commitments`, because a Seed is deliberately not one: nothing ranks it,
 * nothing plans it, and nothing reminds about it. Putting it in the commitment
 * tree would mean every reader of that tree had to remember to exclude it, and
 * the first one that forgot would put somebody's "maybe" into their morning.
 *
 * And not `memory` either: a memory record is a claim about the person, which
 * a maybe is not.
 *
 * The document id is derived from the confirm's idempotency key
 * (`docIdForKey`), so a double-tapped "Keep" writes one seed rather than two.
 */
export const INTENT_SEEDS = 'intentSeeds';

/**
 * What a user confirmed out of a goal's execution graph (#526).
 *
 * `users/{uid}/goalGraphLinks/{linkId}`, one document per confirmed node,
 * holding which node of which goal produced which Commitment or Habit — and
 * nothing else. It is not the graph: the nodes, the edges and the proposals
 * are still recomputed from the goal's own sentence on every request, because
 * a proposal nobody accepted is not worth keeping. What is worth keeping is
 * the decision.
 *
 * The document id is `docIdForKey` of the goal and node ids, which is what
 * makes confirming twice write one link rather than two — the same mechanism
 * `intentSeeds` uses, and for the same reason: a double tap must not produce a
 * second commitment in somebody's week.
 *
 * Deleting a link removes the link. It does not remove the Commitment or the
 * Habit it names, which live in their own collections and are the user's own
 * work; #526 says unlinking may not destroy canonical work unless the user
 * asks for that separately, and keeping the two in different documents is how
 * that is true rather than remembered.
 */
export const GOAL_GRAPH_LINKS = 'goalGraphLinks';

/**
 * Recurring demand on future time the user confirmed (#520).
 *
 * `users/{uid}/habits/{habitId}`, holding the rule only — "gym three times a
 * week" — and never the dates it implies. Occurrences are materialized over a
 * bounded horizon on demand, so there is no collection here that a long-lived
 * habit could grow without limit, which is the storage half of "a Habit never
 * becomes an infinite set of Commitments".
 *
 * Not `commitments`: a commitment is one thing at one time that the user
 * entered; a habit is a standing claim on the week that something else has to
 * find room for. And not the routine profile, which describes the person and
 * asks for nothing.
 */
export const HABITS = 'habits';

/**
 * The dates a habit's rule has actually been materialized onto (#520).
 *
 * `users/{uid}/habitOccurrences/{occurrenceId}`, where the document id *is*
 * `materialize.ts`'s deterministic `{habitId}.{localDate}.{ordinal}`. That is
 * the whole reason this collection can exist without contradicting the note on
 * `HABITS` above: re-running materialization addresses the rows it already
 * wrote instead of appending beside them, so the collection is a function of
 * the habit and the horizon rather than of how many times the job has run.
 *
 * It is a collection rather than an array on the habit for two reasons the
 * domain lane's own design forces. A row carries state the *person* set —
 * `completed`, `skipped` — so it must survive an edit to the rule that
 * produced it, which a regenerated array cannot promise. And the planner reads
 * a date range across every habit at once, which is a collection query and not
 * a fan-out over habit documents.
 *
 * Bounded by `HABIT_HORIZON_MAX_DAYS` on the way in and pruned by
 * `withdrawn` on the way out; `deleteHabitOccurrences` takes the rest when the
 * habit goes.
 */
export const HABIT_OCCURRENCES = 'habitOccurrences';

export const USER_SCOPED_COLLECTIONS = [
  PROVIDER_CONNECTIONS,
  PROVIDER_CREDENTIALS,
  PROVIDER_OAUTH_STATES,
  COMMITMENTS,
  INTENT_SEEDS,
  GOAL_GRAPH_LINKS,
  HABITS,
  HABIT_OCCURRENCES,
  REMINDERS,
  ESCALATION_STATES,
  EVENTS,
  RECOMMENDATION_ACTIONS,
  COMMITMENT_ACTION_RECEIPTS,
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
  MEMORY_DISMISSALS,
  USAGE,
  PLANS,
  PLAN_EVENTS,
  STATS,
  DEVICE_CALENDAR_LINKS,
  FOOTBALL_FOLLOWS,
  EXTERNAL_TASK_REFS,
  FINANCIAL_INPUTS,
  CALENDAR_SOURCES,
  BUSY_BLOCKS,
  ICS_FEEDS,
  ICS_FEED_ITEMS,
  DEVICES,
  PUSH_LOG,
  HARD_REMINDERS,
  WATCHERS,
  WATCHER_EVENTS,
  WATCHER_PROPOSALS,
  WATCHER_NOTIFICATIONS,
  PLANNING_STATE_CHANGES,
  PACK_INSTALLATIONS,
] as const;

/** Operator-only, outside every user tree. */
export const INCIDENTS = 'incidents';

/**
 * A football match, normalized from whichever provider we call this sprint
 * (football fixtures MVP, Task 5).
 *
 * Top-level, not under `users/{uid}`. A fixture is public information about a
 * match, not one person's data: a thousand people following FC Barcelona
 * share exactly one row for Saturday's game. Nesting it per user is the
 * per-user fetch the design rejected, and it is also the reason this
 * collection needs no rules change — `firestore.rules`'s `match /{any=**}`
 * already denies clients everything outside `/users/{uid}`, and this never
 * was going to be under it. Declared free of user data in
 * `lib/account/topLevelUserData.ts` for the same reason.
 */
export const FIXTURES = 'fixtures';

/**
 * The service's own daily model spend, one document per UTC day (#160).
 *
 * Top-level and deliberately not under a uid: it is what MaybeSitter spent,
 * not what a person did, and nesting it in a tree would mean deleting an
 * account erased that day's global count.
 */
export const LLM_USAGE = 'llmUsage';

/**
 * When each curated club was last asked of the fixture provider (football
 * fixtures MVP, Task 9's nightly sync).
 *
 * Top-level and keyed by `clubId`, not under a uid, for the same reason
 * `FIXTURES` is top-level: this is a fact about a club's own sync history,
 * shared by every follower, not a fact about any one account. It exists so a
 * budgeted sync tick can ask "which followed clubs have gone longest without
 * being asked" and pick up where the previous tick left off, rather than
 * re-walking the same prefix of the followed list every time the budget runs
 * out before reaching the end -- see `lib/football/syncFixtures.ts`.
 */
export const FOOTBALL_CLUB_SYNC_STATE = 'footballClubSyncState';

/** The path for one club's sync-state document. `clubId` is already a safe path segment -- `clubs.ts` validates it at load time. */
export function footballClubSyncStateDoc(clubId: string): string {
  return `${FOOTBALL_CLUB_SYNC_STATE}/${requireDocId(clubId)}`;
}

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
 * The path for one fixture, keyed by provider and the provider's own match id.
 *
 * `matchId` is free text handed to us by whichever vendor we are calling —
 * this repo does not control its shape, and nothing stops a provider from
 * using a `/` the way some do for composite ids. `docIdForKey` hashes the
 * combined key instead of concatenating it raw into the path, so a slash in
 * `matchId` cannot split `fixtures/{a}/{b}` out from under this collection.
 */
export function fixtureDoc(provider: string, matchId: string): string {
  return `${FIXTURES}/${docIdForKey(`${provider}:${matchId}`)}`;
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
