/**
 * Deleting an account takes its habits and every date they put on the week
 * (#520).
 *
 * A habit is the part of this product that keeps asking for somebody's time.
 * A habit document that survives a deletion is not a stale row in a table: it
 * is a standing claim on future weeks belonging to a person who asked to be
 * gone, and every occurrence beside it is a dated block the planner would go on
 * offering.
 *
 * Two existing files already hold the *registry* to account — `tests/storage/
 * deletionCoverage.test.ts` checks `USER_SCOPED_COLLECTIONS` against the code,
 * and `tests/account/accountDeletion.test.ts` seeds one synthetic document in
 * each listed collection and deletes it. Both are static in the way that
 * matters here: they seed `{ uid, collection }` at a path they construct
 * themselves, so they would keep passing if the habit stores wrote somewhere
 * else entirely.
 *
 * So nothing here is synthetic. The habit is created through the real service,
 * its occurrences are the real materializer's written at the real store's
 * paths, one of them is answered through the real route so there is history as
 * well as demand, the account goes through the real `deleteAccount`, and the
 * closing assertion is behavioural: the planner adapter, asked for that
 * account's demand afterwards, is given nothing to plan.
 *
 * Modelled on `tests/account/watcherDeletionCoverage.test.ts`, which makes the
 * same argument for #527.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import {
  HABITS,
  HABIT_OCCURRENCES,
  USER_SCOPED_COLLECTIONS,
  userDoc,
} from '../../lib/storage/paths.ts';
import { deleteAccount, type DeletionAuthAdmin } from '../../lib/account/accountDeletion.ts';
import { resetDeletionHooksForTests } from '../../lib/account/deletionHooks.ts';
import {
  applyOccurrenceOutcome,
  createHabitServices,
  createHabitWithOccurrences,
  loadHabitDemand,
} from '../../lib/services/habits/habitService.ts';
import { buildHabitPlanningRequest } from '../../lib/services/habits/habitPlanningAdapter.ts';
import type { HabitDefinitionInput } from '../../src/contracts/v1/habitContracts.ts';

const PEPPER = 'test-pepper-not-the-real-one';
const TARGET = 'user_with_habits_deleted';
const SIBLING = 'user_still_has_habits';
const NOW = '2026-03-01T09:00:00.000Z';
/** A Monday, so a `weekdays: [1]` habit has demand from the first horizon day. */
const TODAY = '2026-03-02';

/** Every collection a habit can leave something in. */
const HABIT_COLLECTIONS = [HABITS, HABIT_OCCURRENCES] as const;

let storage: MemoryStorageAdapter;

function fakeAuth(): DeletionAuthAdmin {
  return { async revokeRefreshTokens() {}, async deleteUser() {} };
}

function habitInput(scopeId: string): HabitDefinitionInput {
  return {
    scopeId,
    title: 'Gym',
    cadence: { kind: 'weekdays', weekdays: [1, 3] },
    durationMinutes: 60,
    preferredWindows: [{ start: '18:00', end: '21:00' }],
    minimumOccurrences: 2,
    maximumOccurrences: 2,
    flexibility: 'protected_flexible',
    recoveryPolicy: 'skip',
    source: 'user_created',
    confirmation: { confirmedByUserAt: NOW, sourceRef: null, acceptedSuggestedValues: false },
  };
}

/** Everything under `users/{uid}/` in any habit collection. */
async function habitRowsFor(uid: string): Promise<string[]> {
  const prefix = `${userDoc(uid)}/`;
  const rows: string[] = [];
  for (const collection of HABIT_COLLECTIONS) {
    rows.push(...(await storage.listGroup(collection))
      .filter((row) => row.path.startsWith(prefix))
      .map((row) => row.path));
  }
  return rows.sort();
}

/**
 * An account with a habit that has actually been lived in: four weeks of
 * materialized dates, and one of them answered, so the fixture holds both
 * future demand and past history.
 */
async function seedHabitAccount(uid: string): Promise<string> {
  const services = createHabitServices(storage);
  const { habit } = await createHabitWithOccurrences(services, habitInput(uid), NOW, TODAY);
  const occurrences = await services.occurrences.listForHabit(uid, habit.habitId);
  assert.ok(occurrences.length >= 4, `the fixture materialized only ${occurrences.length} dates`);
  // A *later* date, deliberately. Answering the first one would complete the
  // very Monday the planner assertion below then asks about, and that test
  // would fail for a fixture reason rather than a deletion one.
  const history = occurrences[occurrences.length - 1];
  assert.notEqual(history.localDate, TODAY);
  const answered = await applyOccurrenceOutcome(
    services, uid, habit.habitId, history.occurrenceId, 'completed', TODAY,
  );
  assert.equal(answered.transition.kind, 'applied', 'the fixture recorded no history');
  return habit.habitId;
}

function begin(): void {
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = PEPPER;
  resetDeletionHooksForTests();
  storage = createMemoryStorage();
}

function end(): void {
  resetDeletionHooksForTests();
  delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
}

test('a deleted account keeps no habit and none of the dates it asked for', async () => {
  begin();
  try {
    await storage.set(userDoc(TARGET), { uid: TARGET });
    await storage.set(userDoc(SIBLING), { uid: SIBLING });
    await seedHabitAccount(TARGET);
    await seedHabitAccount(SIBLING);

    // The seed is real, and it reached both collections. A deletion test whose
    // fixture never landed proves nothing, and this is the half the synthetic
    // seeds elsewhere cannot state: these paths were chosen by the stores, not
    // by this file.
    const before = await habitRowsFor(TARGET);
    for (const collection of HABIT_COLLECTIONS) {
      assert.ok(
        before.some((path) => path.includes(`/${collection}/`)),
        `nothing was written to ${collection}, so its deletion is not being tested`,
      );
    }

    await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth: fakeAuth() });

    assert.deepEqual(
      await habitRowsFor(TARGET),
      [],
      'a deleted account still has habits asking for its time',
    );
    assert.equal(await storage.get(userDoc(TARGET)), null);

    // The control. A deletion that emptied the database would satisfy every
    // assertion above.
    const sibling = await habitRowsFor(SIBLING);
    for (const collection of HABIT_COLLECTIONS) {
      assert.ok(
        sibling.some((path) => path.includes(`/${collection}/`)),
        `deleting one account removed another account's ${collection}`,
      );
    }
  } finally {
    end();
  }
});

test('the planner is given nothing to schedule for a deleted account', async () => {
  begin();
  try {
    await storage.set(userDoc(TARGET), { uid: TARGET });
    await storage.set(userDoc(SIBLING), { uid: SIBLING });
    await seedHabitAccount(TARGET);
    await seedHabitAccount(SIBLING);

    const services = createHabitServices(storage);
    const horizon = { from: TODAY, to: '2026-03-29' };

    // The behavioural claim, and the reason this file exists rather than a
    // path assertion alone. Demand is read through the same call the daily
    // plan makes, and turned into planning items by the same adapter, so a
    // document that survived a deletion would show up here as a block on a
    // real person's calendar rather than as a row in a table.
    const beforeDemand = await loadHabitDemand(services, TARGET, horizon.from, horizon.to);
    const beforeItems = buildHabitPlanningRequest({
      definitions: beforeDemand.definitions,
      occurrences: beforeDemand.occurrences,
      localDate: TODAY,
      timezone: 'UTC',
      earliestStartAt: null,
    }).items;
    assert.ok(beforeItems.length > 0, 'the fixture asks the planner for nothing, so this proves nothing');

    await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth: fakeAuth() });

    const afterDemand = await loadHabitDemand(services, TARGET, horizon.from, horizon.to);
    assert.deepEqual(afterDemand.definitions, [], 'a deleted account still has habit rules');
    assert.deepEqual(afterDemand.occurrences, [], 'a deleted account still has dated demand');
    assert.deepEqual(
      buildHabitPlanningRequest({
        definitions: afterDemand.definitions,
        occurrences: afterDemand.occurrences,
        localDate: TODAY,
        timezone: 'UTC',
        earliestStartAt: null,
      }).items,
      [],
      'the planner is still being asked to find room for a deleted account\'s habits',
    );

    // And the neighbour, who is still a user, still has theirs.
    const siblingDemand = await loadHabitDemand(services, SIBLING, horizon.from, horizon.to);
    assert.ok(siblingDemand.definitions.length > 0, 'deleting one account removed another account\'s habits');
    assert.ok(siblingDemand.occurrences.length > 0, 'deleting one account removed another account\'s dates');
  } finally {
    end();
  }
});

test('every habit collection is one the deletion tests are held to', () => {
  // The registry direction. `deleteTree` is structural in both adapters, so it
  // is `USER_SCOPED_COLLECTIONS` that follows the data rather than the data
  // that follows the list. What the list governs is the *checking*:
  // `tests/storage/deletionCoverage.test.ts` and `tests/account/
  // accountDeletion.test.ts` seed and assert exactly the collections it names,
  // so a habit collection missing from it is a collection those two files stop
  // looking at.
  //
  // `habitOccurrences` is the one this lane added, and the domain lane's
  // `habitStore.ts` left the registration to whoever added occurrence
  // persistence. This says out loud that it was done.
  for (const collection of HABIT_COLLECTIONS) {
    assert.ok(
      (USER_SCOPED_COLLECTIONS as readonly string[]).includes(collection),
      `${collection} is not in USER_SCOPED_COLLECTIONS, so account deletion does not cover it`,
    );
  }
});
