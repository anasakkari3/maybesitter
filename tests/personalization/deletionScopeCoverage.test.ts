/**
 * "Delete everything" is held to the collection list, not to memory (UC-3.16, #202).
 *
 * `deletePersonalizationScope` purges the stores a profile is derived from. It
 * shipped purging two of them and leaving `behaviorFeedback` — the counters the
 * *shipped* `adaptiveService` classifier reads — and `profileProposals`, which
 * can be confirmed into a fresh memory record after the deletion. Both were
 * missed the same way: the cascade named its stores one at a time and nothing
 * checked that list against the set of places a user's data lives.
 *
 * `tests/storage/deletionCoverage.test.ts` already holds *account* deletion to
 * `USER_SCOPED_COLLECTIONS`. This is the same discipline for the narrower
 * button, and the difference is what makes it more than a copy: account
 * deletion must empty every collection, while this one must empty exactly the
 * derived ones and leave the user's own content alone. So every collection is
 * classified here, and a collection in neither list fails the run — which is
 * the only thing that makes the next store added a decision rather than an
 * omission.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import {
  BEHAVIOR_FEEDBACK,
  docIdForKey,
  FEEDBACK_BASELINES,
  FEEDBACK_EVENTS,
  FOOTBALL_FOLLOWS,
  MEMORY,
  MEMORY_DISMISSALS,
  PROFILE_PROPOSALS,
  USER_SCOPED_COLLECTIONS,
  userDoc,
  userSubDoc,
} from '../../lib/storage/paths.ts';
import { deletePersonalizationScope } from '../../lib/personalization/deletion.ts';
import { createStorageFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { feedbackScopeIdFor } from '../../lib/feedbackHistory/feedbackHistoryRoutes.ts';
import { scopeBehaviorFeedback } from '../../lib/services/behaviorFeedbackService.ts';

const TARGET = 'user_forgetme';
const SIBLING = 'user_bystander';
const NOW = '2026-09-14T09:00:00.000Z';

/** Emptied by "delete everything": a profile is derived from these. */
const PURGED: ReadonlySet<string> = new Set([
  FEEDBACK_EVENTS,
  FEEDBACK_BASELINES,
  MEMORY,
  BEHAVIOR_FEEDBACK,
  PROFILE_PROPOSALS,
  MEMORY_DISMISSALS,
  FOOTBALL_FOLLOWS,
]);

/**
 * Collections classified `PURGED` whose sweep is not wired yet. Empty today:
 * `FOOTBALL_FOLLOWS` was the one entry while no store wrote it, and
 * `deletePersonalizationScope` now clears it with
 * `clearUserCollection(storage, scopeId, FOOTBALL_FOLLOWS)`, so it is purged
 * and checked by the ordinary `PURGED` branch below like the rest.
 *
 * The set stays as a mechanism, not a comment. An exemption nothing checks is
 * indistinguishable from a hole -- that is how `behaviorFeedback` and
 * `profileProposals` were missed (see the file header) -- so a collection
 * added here is still seeded by the behavioral test below, which asserts that
 * it *survives*. The day its sweep lands, that assertion fails with a message
 * naming the remedy: remove the entry and let the `PURGED` branch take over.
 * The escape hatch expires loudly instead of silently.
 */
const NOT_YET_WIRED: ReadonlySet<string> = new Set([]);

/**
 * Kept on purpose, each with the reason it is not a derived profile.
 *
 * These go with *account* deletion, which `deletionCoverage.test.ts` covers.
 * A user who asks to be forgotten is not asking to lose their week.
 */
const KEPT: ReadonlyMap<string, string> = new Map(
  USER_SCOPED_COLLECTIONS
    .filter((collection) => !PURGED.has(collection))
    .map((collection) => [collection, ''] as const),
);

/** The reasons, spelled out. Every key here must be in `KEPT`. */
const KEPT_BECAUSE: Record<string, string> = {
  commitments: 'the user’s own content',
  intentSeeds:
    'the user’s own words about something they have not decided to do (#519) — a sentence they '
    + 'picked in Review, a kind from a closed set of four, and a status they chose. Nothing here '
    + 'is derived: no confidence, no maturity score, nothing a model or a background job can '
    + 'write. "Forget what you inferred about me" must not silently delete the maybes somebody '
    + 'deliberately kept, any more than it deletes their commitments; the way to remove one is '
    + 'the Dismiss beside it, and account deletion takes the whole tree.',
  goalGraphLinks:
    'which proposal out of a goal\u2019s execution graph the user accepted, and what it became (#526) \u2014 '
    + 'a goal memory id, a node id and the id of the Commitment or Habit it produced. Nothing here is '
    + 'derived and nothing is a claim about the person: it is the record of a decision they made by '
    + 'pressing confirm, the same standing as the commitment on the other end of it. "Forget what you '
    + 'inferred about me" must not quietly detach somebody\u2019s goal from the work they chose to do '
    + 'for it; unlinking is the control beside the node, and account deletion takes the whole tree.',
  habits:
    'a rule the user confirmed about their own week (#520) — "gym three times a week", with the '
    + 'cadence and the duration they accepted by hand. It is their own content in the same sense a '
    + 'commitment is, not a belief the product formed about them: nothing here is derived, there is '
    + 'no confidence and no score, and it exists at all only because somebody pressed a confirm. '
    + '"Forget what you inferred about me" must not empty somebody’s week; pausing or deleting one '
    + 'is the control beside it, and account deletion takes the whole tree.',
  habitOccurrences:
    'the dates a kept `habits` rule has been materialized onto, and what the person answered about '
    + 'each one (#520). Kept for the reason the rule is, twice over: the pending rows are that same '
    + 'confirmed rule expressed as a week, so purging them would empty somebody’s calendar while '
    + 'leaving the habit that claims to fill it; and the `completed` and `skipped` rows are the '
    + 'person’s own answers about their own days, which is the `stats` ruling exactly — this button '
    + 'forgets what was inferred about someone, never what they did. Nothing here is derived: there '
    + 'is no score, no streak and no confidence, only a date, a state and a duration. Deleting the '
    + 'habit takes its dates with it, and account deletion takes the whole tree.',
  financialInputs:
    'what the user typed about their own money (#financial-v1) — a salary they entered, a bill '
    + 'only they know about, a balance they corrected by hand. Kept for the reason `commitments` '
    + 'is: none of it is derived, there is no score and no confidence, and every row exists '
    + 'because somebody filled in a field. It is also the collection this button would be most '
    + 'damaging to get wrong, because it is the only place a correction lives — purging it would '
    + 'hand every field the user had overruled back to the bank without telling them. Nothing '
    + 'inferred is in here to forget: the balances, the cadence and the buffer are computed at '
    + 'read time and never written down. Removing one row is the control beside it, and account '
    + 'deletion takes the whole tree.',
  reminders: 'scheduling for the user’s own content',
  escalationStates: 'live delivery state for a commitment that still exists',
  events: 'the domain log the user’s content is replayed from',
  recommendationActions: 'what was offered and answered, not a claim about the person',
  commitmentActionReceipts:
    'which notification taps were already applied (#200): ids and an action, kept so a replayed tap '
    + 'is not applied twice; not a claim about the person',
  nextStepDecisions: 'the user’s own answers to a question',
  auditEvents: 'the record that the deletion happened; erasing it erases the receipt',
  consents: 'the user’s own decision, not something derived about them',
  studyResponses: 'what the user chose to tell a study',
  alphaTraces: 'operator diagnostics, removed with the account',
  alphaFeedback: 'what the user chose to report',
  pressureDelivery:
    'a brake, not a belief: it records when the product last nudged so the next '
    + 'nudge is suppressed, and clearing it would answer "forget me" by making the '
    + 'product free to push again — the loop #107 and #388 refuse. Keyed to '
    + 'commitments, and it goes with them on account deletion.',
  clarifications: 'a pending question about the user’s own content',
  clarificationEvents: 'which field was asked about; no free text and no claim about the person',
  analyticsEvents: 'product telemetry with its own retention, not a profile the screen shows',
  captureProposals: 'the user’s own words awaiting confirmation',
  usage: 'what the account spent, needed for billing and abuse limits',
  plans: 'the user’s own day, built from their own commitments and rebuilt each morning; erasing it loses today, not a belief about them',
  planEvents: 'what the user did to their own plan — a type, a date, a generation and a digest, with no titles and no explanation text',
  deviceCalendarLinks:
    'a pointer to an event in the user’s own phone calendar — a calendar id, an event id and a '
    + 'content hash, with no title and nothing read back out of the calendar. Not a belief about '
    + 'the person, and erasing it would orphan every event MaybeSitter added: the app would no '
    + 'longer know which entries were its own, so "remove the events MaybeSitter added" could not '
    + 'find them and a re-confirm would write a second copy beside each one. The tombstones matter '
    + 'as much as the live rows — a `detached` row is the record that the user deleted that event '
    + 'by hand, and clearing it is how the product starts putting it back.',
  calendarSources:
    'a record that the user connected a calendar of their own — its kind, the platform, the '
    + 'window the last sync covered and when it ran. Not a belief about the person, and the way '
    + 'to remove it is the Disconnect button UC-3.2 (#186) puts beside it, which deletes the '
    + 'source and every block under it in one action the user can see the result of.',
  busyBlocks:
    'intervals mirrored from the user’s own calendar — a start, an end and an all-day flag, with '
    + 'no title, notes, location or attendee, because `toBusyBlocks` on the phone never let one '
    + 'cross. Nothing here was inferred: it is a copy of what their calendar already says, and it '
    + 'is restated in full by the next sync, so purging it here would answer "forget what you '
    + 'worked out about me" by deleting something for fifteen minutes. Disconnect is the button '
    + 'that means this, and account deletion takes it with everything else.',
  icsFeeds:
    'the calendar feeds the user subscribed to by pasting a link (UC-3.4, #188) — a label, a '
    + 'toggle, refresh bookkeeping and the feed URL encrypted. A subscription the user made, not a '
    + 'belief about them; purging it here would silently unsubscribe them. Removing the feed is '
    + 'the button beside it, and account deletion takes it with everything else.',
  icsFeedItems:
    'deadlines a subscribed feed proposed and what the user answered — a cleaned title, a due '
    + 'time and accepted/rejected/pending. A copy of what their university calendar says plus '
    + 'their own decisions, not an inference; clearing it would re-propose every deadline they '
    + 'already dismissed on the next refresh. Removing the feed deletes these rows.',
  devices:
    'the phones this account signed in on, and the FCM token to reach each of '
    + 'them. A device identifier, not a belief about the person: "forget what '
    + 'you inferred about me" must not silently stop the reminders they asked '
    + 'for on the phone in their hand. Signing out deletes the row, and account '
    + 'deletion takes the whole tree (UC-3.0b, #184).',
  pushLog:
    'the idempotency locks for pushes already sent — a key, a kind and two '
    + 'instants, with none of the text. Clearing it would let every push whose '
    + 'key is still live be sent a second time, so answering "forget me" with a '
    + 'duplicate notification. It expires on its own seven days out via the '
    + '`expiresAt` TTL field, which is the retention this needs.',
  hardReminders:
    'one row per Must commitment whose reminder the server may have to back up — the commitment '
    + 'id, the instant it is for, a status, and the receipt a phone uploaded saying it will ring '
    + 'locally. An index over the user’s own commitments, not a belief about them: clearing it '
    + 'would answer "forget what you inferred about me" by silently dropping the backup for the '
    + 'reminders they explicitly asked to ring, and the next commitment write or receipt upload '
    + 'would rebuild it anyway. It goes with the commitment (a completed one deletes its row), '
    + 'with account deletion, and with the `expiresAt` TTL two days past the reminder.',
  stats: 'the user’s own record of what they did — the counters behind the weekly Moments. #201 made a Moment survive deleting the commitment that earned it, on the ground that a fact about something that happened must not unhappen; this button forgets what was inferred about the person, not what the person achieved.',
  providerConnections:
    'a grant the user made to a third party, the same kind of explicit act as `consents`. This button '
    + 'forgets what MaybeSitter inferred about someone, and disconnecting their Google account is not an '
    + 'inference — it is an action they took and can only undo themselves. Silently revoking it would '
    + 'answer "forget what you learned about me" by breaking a connection they still expect to work. It '
    + 'holds no belief about the person: an identity, a state, granted scopes and a pointer to the '
    + 'credential. It goes on account deletion, where `deleteTree` covers it.',
  providerCredentials:
    'the encrypted token behind a `providerConnections` row, and it has to live and die with that row. '
    + 'Purging it alone would leave a connection that reports itself connected and cannot fetch anything, '
    + 'which is a worse state than either connected or disconnected. It is a bearer secret, never a claim '
    + 'about the person. Disconnecting removes it through the vault, and account deletion removes it with '
    + 'the tree.',
  providerOAuthStates:
    'an authorization in flight, between the redirect and the callback, holding a PKCE verifier and living '
    + 'for minutes. It is machinery rather than anything learned about the user, and it is consumed by the '
    + 'callback or expires on its own. Purging it would abort a connection the user started seconds '
    + 'earlier, for no privacy gain that waiting out the expiry does not already give.',
  watchers:
    'a watcher the user set up by saying "watch this for me" (#525) — a provider, a connection, a '
    + 'normalized signal kind, an opaque subject and one of four effects. It is a standing instruction '
    + 'they gave, the same kind of explicit act as `consents` or `icsFeeds`, not something inferred '
    + 'about them; purging it here would answer "forget what you worked out about me" by silently '
    + 'switching off the monitoring they asked for. The Delete button beside it is how one is removed, '
    + 'and account deletion takes the whole tree.',
  watcherEvents:
    'one row per watcher firing: ids, an instant, a reason code, the policy decision and a provenance '
    + 'pointer, with no title and no provider payload — the contract has no field that could carry one. '
    + 'It is the record of what the product already told this account, and it is also the idempotency '
    + 'lock keyed on (watcherId, signalId): clearing it would let every still-current observation fire a '
    + 'second time, so answering "forget me" with a repeat notification.',
  watcherProposals:
    'what a `propose_commitment` watcher offered and the user has not answered yet — the same standing '
    + 'as `captureProposals`, which is kept for the same reason. It holds a signal kind, an opaque '
    + 'subject and a reason code, never a claim about the person.',
  watcherNotifications:
    'a queued, content-free notification intent a `notify` watcher produced, awaiting the surface that '
    + 'renders it (#527). It names a watcher, a signal kind and a reason code and nothing else; purging '
    + 'it would drop a notification the user asked for rather than forget anything about them.',
  planningStateChanges:
    'the entry of the common state-change pipeline: a source, an entity id, two digests and an instant. '
    + 'It says something changed that a plan may care about, never what the product concluded about the '
    + 'person, and it is consumed and aged out by the replanning lane rather than by this button.',
  packInstallations:
    'which vertical packs the account has switched on (#528) \u2014 a pack id, a state, a reason code and '
    + 'the ids of the watchers that pack\u2019s templates produced. It is the record of a switch a person '
    + 'flipped, not a belief the product formed about them: nothing here is derived, there is no score and '
    + 'no confidence. Purging it would silently orphan the watchers it names, leaving a pack running that '
    + 'nothing can turn off; the way to remove one is to disable the pack, and account deletion takes the '
    + 'whole tree.',
  externalTaskRefs:
    'a pointer beside a commitment, same as deviceCalendarLinks: which external fixture a commitment came '
    + 'from and whether the user dismissed it. Commitments survive this purge, so the ref that keeps a '
    + 'dismissal honoured must survive with them — erasing it would let the next sync recreate a match '
    + 'the user explicitly removed.',
};

test('every user-scoped collection is either purged by "delete everything" or deliberately kept', () => {
  const unclassified = USER_SCOPED_COLLECTIONS
    .filter((collection) => !PURGED.has(collection) && !(collection in KEPT_BECAUSE));
  assert.deepEqual(
    unclassified,
    [],
    'a user-scoped collection is neither purged nor deliberately kept: decide which, in lib/personalization/deletion.ts',
  );

  // The converse, so the reason list cannot rot into naming something gone.
  const stale = Object.keys(KEPT_BECAUSE).filter((collection) => !KEPT.has(collection));
  assert.deepEqual(stale, [], 'a reason names a collection that is no longer kept, or no longer exists');

  for (const [collection, reason] of Object.entries(KEPT_BECAUSE)) {
    assert.ok(reason.length > 20, `${collection} is kept without a reason anyone can weigh`);
  }
});

/**
 * The ids seeded into one collection for one user.
 *
 * Two per collection, the second under an id no store derives. A purge that
 * removed only the one id a store computes would pass with a single seed — and
 * that is exactly how `behaviorFeedback` was missed, since its own `clear`
 * deletes one path.
 *
 * `feedbackBaselines` is the one collection where a second row would be a
 * fiction: `feedbackEventStore` is its only writer, it writes one document per
 * scope at a derived id, and no code path can produce another. Seeding one
 * there keeps the assertion about a state the product can actually reach.
 */
function seedIdsFor(collection: string, uid: string): readonly string[] {
  return collection === FEEDBACK_BASELINES ? [docIdForKey(uid)] : ['seed', 'stray'];
}

test('the purge empties every derived collection for the scope and touches nobody else', async () => {
  const storage = createMemoryStorage();
  for (const uid of [TARGET, SIBLING]) {
    await storage.set(userDoc(uid), { uid });
    for (const collection of USER_SCOPED_COLLECTIONS) {
      for (const id of seedIdsFor(collection, uid)) {
        await storage.set(userSubDoc(uid, collection, id), { uid, collection, scopeId: uid });
      }
    }
  }
  for (const collection of USER_SCOPED_COLLECTIONS) {
    assert.equal(
      (await storage.list(`${userDoc(TARGET)}/${collection}`)).length,
      seedIdsFor(collection, TARGET).length,
      `the seed never reached ${collection}, so this run would prove nothing`,
    );
  }

  await deletePersonalizationScope({
    scopeId: TARGET,
    now: NOW,
    storage,
    feedbackEvents: createStorageFeedbackEventStore(storage),
    runtimeMemory: createStorageRuntimeMemoryStore(undefined, storage),
  });

  for (const collection of USER_SCOPED_COLLECTIONS) {
    const mine = await storage.list(`${userDoc(TARGET)}/${collection}`);
    if (NOT_YET_WIRED.has(collection)) {
      // Classified PURGED, but nothing sweeps it yet — see NOT_YET_WIRED's own
      // comment for why this asserts today's truth rather than skipping the
      // collection. The moment a real clearUserCollection call is added for
      // it, this flips to failing, and the message says what to do about it.
      assert.equal(
        mine.length,
        seedIdsFor(collection, TARGET).length,
        `${collection} is in NOT_YET_WIRED because its sweep is not wired yet — if this `
          + `assertion just failed, the wiring landed: remove ${collection} from `
          + 'NOT_YET_WIRED and let the purge branch below cover it',
      );
    } else if (PURGED.has(collection)) {
      assert.deepEqual(
        mine.map((row) => row.id),
        [],
        `${collection} survived "delete everything", so something derived about the user is still held`,
      );
    } else {
      assert.equal(
        mine.length,
        seedIdsFor(collection, TARGET).length,
        `${collection} was erased by "delete everything": ${KEPT_BECAUSE[collection] ?? 'unclassified'}`,
      );
    }
    assert.equal(
      (await storage.list(`${userDoc(SIBLING)}/${collection}`)).length,
      seedIdsFor(collection, SIBLING).length,
      `deleting one account's derived data also reached another user's ${collection}`,
    );
  }
});

test('the receipt reports the derived stores it now purges', async () => {
  const storage = createMemoryStorage();
  await storage.set(userSubDoc(TARGET, BEHAVIOR_FEEDBACK, 'seed'), { uid: TARGET });
  await storage.set(userSubDoc(TARGET, PROFILE_PROPOSALS, 'seed'), { uid: TARGET });

  const receipt = await deletePersonalizationScope({
    scopeId: TARGET,
    now: NOW,
    storage,
    feedbackEvents: createStorageFeedbackEventStore(storage),
    runtimeMemory: createStorageRuntimeMemoryStore(undefined, storage),
  });

  // Re-listed from the store after the deletes, never subtracted from what a
  // delete claimed — the discipline the rest of the receipt already keeps.
  assert.equal(receipt.remainingBehaviorFeedbackCount, 0);
  assert.equal(receipt.remainingProfileProposalCount, 0);
});

test('the product files behaviour counters under the uid, which is what this purge can reach', () => {
  // The purge walks `users/{uid}/behaviorFeedback`. It reaches a row only if
  // the scope the product writes under is the uid. UC-1.0e (#144) made that
  // true at the authenticated entry point; this fails if it stops being true.
  assert.equal(feedbackScopeIdFor(TARGET), TARGET);
  assert.equal(scopeBehaviorFeedback({ userId: TARGET }), TARGET);

  // And the documented hole, asserted rather than described: a conversation or
  // session id produces a different scope, which lands outside this user's
  // tree entirely and is therefore outside account deletion too. Only the
  // frozen web `POST /api/agenda/action` can supply one.
  assert.notEqual(scopeBehaviorFeedback({ userId: TARGET, conversationId: 'conv-1' }), TARGET);
});
