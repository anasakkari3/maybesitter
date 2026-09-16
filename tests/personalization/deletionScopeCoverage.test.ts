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
]);

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
  reminders: 'scheduling for the user’s own content',
  escalationStates: 'live delivery state for a commitment that still exists',
  events: 'the domain log the user’s content is replayed from',
  recommendationActions: 'what was offered and answered, not a claim about the person',
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
    if (PURGED.has(collection)) {
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
