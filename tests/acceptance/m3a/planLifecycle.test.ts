/**
 * M3a Gate B, the plan's life after the confirm: goal edit and deletion,
 * later weeks and Today's card, the statement entry, the plan imperative,
 * moving a plan block, and the daily plan's typed failures (PLAN-M3a.md v7:
 * M3A-005, -010, -012, -014, -028, -032, -033, -036, -039, -041 to -044,
 * -048 to -050, -052, acceptance 5 and 6; shapes from WIRE-M3a.md). Gate
 * author: Claude.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMITMENTS, EVENTS, MEMORY, PLANS, GOAL_GRAPH_LINKS, HABITS, HABIT_OCCURRENCES, USER_SCOPED_COLLECTIONS, userCol } from '../../../lib/storage/paths.ts';
import { getStorage } from '../../../lib/storage/index.ts';
import {
  OTHER, TODAY, USER, addBusy, addDays, approved, at, call, choose, commitments, confirm, draftOf, generate, key, overlaps, rows, setup,
  stepByTitle, stepTimes, type Plan, type Times,
} from './support.ts';

const WALK = 'امشي نص ساعة'; // walk half an hour
const WEIGH = 'قيس وزنك وراجع الأكل'; // weigh yourself and review food

async function within<T>(fn: () => Promise<T>, h: { restore(): void }): Promise<T> {
  try { return await fn(); } finally { h.restore(); }
}

async function editGoal(goalId: string, content: string): Promise<string> {
  const answer = await call('memory/[id]', 'PATCH', { id: goalId }, { content });
  assert.equal(answer.status, 200, `goal edit: ${JSON.stringify(answer.body)}`);
  return answer.body.memory.id as string;
}

async function deleteGoal(goalId: string): Promise<number> {
  return (await call('memory/[id]', 'DELETE', { id: goalId })).status;
}

async function confirmed(goalId: string): Promise<{ plan: Plan; times: Times; answer: Record<string, any>; k: string }> {
  const { plan, times } = await approved(goalId);
  const k = key('confirm');
  const result = await confirm(goalId, times, k);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { plan, times, answer: result.body, k };
}

/** Every user-scoped document that mentions the goal id, outside the canonical work and the event log. */
async function goalOwnedDocuments(goalId: string): Promise<string[]> {
  const canonical = new Set<string>([COMMITMENTS, HABITS, HABIT_OCCURRENCES, EVENTS]);
  const found: string[] = [];
  for (const collection of USER_SCOPED_COLLECTIONS) {
    if (canonical.has(collection)) continue;
    for (const row of await getStorage().list(userCol(USER, collection))) {
      if (JSON.stringify(row.data).includes(goalId)) found.push(`${collection}/${row.id}`);
    }
  }
  return found;
}

/* ── the new stores are account data (M3A-010) ─────────────────────── */

test('M3A-010 a plan is stored in user-scoped collections, so export and deletion reach it', async () => {
  const h = await setup();
  await within(async () => {
    await draftOf(h.goalId);
    assert.ok((await goalOwnedDocuments(h.goalId)).length > 0, 'the plan is stored outside USER_SCOPED_COLLECTIONS');
    const exported = await call('account/export', 'GET', {});
    assert.equal(exported.status, 200);
    assert.ok(JSON.stringify(exported.body).includes(WALK), 'the export does not include the plan');
  }, h);
});

/* ── goal edit (M3A-014, -028, -044, -049, -050, -052) ─────────────── */

test('M3A-028 M3A-044 editing a confirmed goal keeps its saved work linked and lets a new plan start', async () => {
  const h = await setup();
  await within(async () => {
    await confirmed(h.goalId);
    const newGoalId = await editGoal(h.goalId, 'بدي أنزل 5 كيلو'); // I want to lose 5 kilos
    assert.notEqual(newGoalId, h.goalId);

    const links = await rows(GOAL_GRAPH_LINKS);
    assert.equal(links.filter((l) => JSON.stringify(l).includes(newGoalId)).length, 2, 'the links did not follow the goal');
    assert.equal(links.filter((l) => JSON.stringify(l).includes(h.goalId)).length, 0, 'links still point at the replaced goal');

    const view = await call('goals/[goalId]/plan', 'GET', { goalId: newGoalId });
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.draft, null);
    assert.equal(view.body.confirmed, null, 'the replaced goal’s plan is still the current one');
    assert.equal((view.body.linkedWork as unknown[]).length, 2, 'the saved work is not shown as already saved');

    const fresh = await generate(newGoalId);
    assert.equal(fresh.status, 200, `start over is unreachable: ${JSON.stringify(fresh.body)}`);
  }, h);
});

test('M3A-014 editing the goal drops the unresolved later steps from Today', async () => {
  const h = await setup();
  await within(async () => {
    await confirmed(h.goalId);
    await editGoal(h.goalId, 'بدي أنزل 5 كيلو'); // I want to lose 5 kilos
    h.setTime(at(addDays(TODAY, 10), '10:00'));
    const upcoming = await call('goals/plans/upcoming', 'GET', {});
    assert.equal(upcoming.status, 200);
    assert.deepEqual(upcoming.body.items, [], 'a later week of the replaced plan still shows');
  }, h);
});

test('M3A-049 M3A-052 a confirm for a goal edited meanwhile answers 409 goal_superseded and writes nothing', async () => {
  const h = await setup();
  await within(async () => {
    const { times } = await approved(h.goalId);
    const newGoalId = await editGoal(h.goalId, 'بدي أنزل 5 كيلو'); // I want to lose 5 kilos
    const answer = await confirm(h.goalId, times);
    assert.equal(answer.status, 409);
    assert.equal(answer.body.reason, 'goal_superseded');
    assert.equal(answer.body.currentGoalId, newGoalId);
    assert.equal((await commitments()).length, 0);
    assert.equal((await rows(HABITS)).length, 0);
  }, h);
});

test('M3A-050 a confirm whose answer was lost replays its outcome even after the goal was edited', async () => {
  const h = await setup();
  await within(async () => {
    const { times, answer, k } = await confirmed(h.goalId);
    await editGoal(h.goalId, 'بدي أنزل 5 كيلو'); // I want to lose 5 kilos
    const replay = await confirm(h.goalId, times, k);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body.saved, answer.saved);
    assert.deepEqual(replay.body.stayed, answer.stayed);
    assert.equal(replay.body.receipt.replayed, true);
  }, h);
});

/* ── goal deletion (M3A-010, -014, -042) ───────────────────────────── */

test('M3A-014 deleting a goal deletes its plans, outcomes and links, keeps the saved work, and a replay answers 410', async () => {
  const h = await setup();
  await within(async () => {
    const { times, k } = await confirmed(h.goalId);
    const saved = (await commitments()).length;
    assert.equal(await deleteGoal(h.goalId), 200);
    assert.deepEqual(await goalOwnedDocuments(h.goalId), [], 'documents of the deleted goal remain');
    assert.equal((await commitments()).length, saved, 'deleting the goal deleted the person’s commitments');
    const replay = await confirm(h.goalId, times, k);
    assert.equal(replay.status, 410);
    assert.equal(replay.body.reason, 'gone');
  }, h);
});

test('M3A-042 a delete racing a confirm leaves no plan, outcome or link behind', async () => {
  const h = await setup();
  await within(async () => {
    const { times } = await approved(h.goalId);
    const [answer] = await Promise.all([confirm(h.goalId, times), deleteGoal(h.goalId)]);
    assert.ok([200, 410].includes(answer.status), `confirm answered ${answer.status} ${JSON.stringify(answer.body)}`);
    assert.deepEqual(await goalOwnedDocuments(h.goalId), [], 'an orphan survived the race');
  }, h);
});

test('M3A-042 a delete racing a generate leaves no draft behind', async () => {
  const h = await setup();
  await within(async () => {
    const [answer] = await Promise.all([generate(h.goalId), deleteGoal(h.goalId)]);
    assert.ok([200, 410, 404].includes(answer.status), `generate answered ${answer.status}`);
    assert.deepEqual(await goalOwnedDocuments(h.goalId), [], 'a draft or claim survived the race');
  }, h);
});

/* ── later weeks and Today's card (M3A-012, -026, -033, -039, -041, -048) ── */

test('M3A-033 M3A-048 Today’s card shows a later week within 7 days of its start, and only then', async () => {
  const h = await setup();
  await within(async () => {
    const { plan } = await confirmed(h.goalId);
    const now = await call('goals/plans/upcoming', 'GET', {});
    assert.equal(now.status, 200, JSON.stringify(now.body));
    assert.deepEqual(now.body.items, [], 'week 3 shown two weeks early');

    h.setTime(at(addDays(TODAY, 8), '10:00'));
    const soon = await call('goals/plans/upcoming', 'GET', {});
    assert.equal(soon.body.items.length, 1);
    const item = soon.body.items[0];
    assert.equal(item.goalId, h.goalId);
    assert.equal(item.planId, plan.planId);
    assert.equal(item.weekIndex, 3);
    assert.equal(item.stepCount, 1);
    assert.equal(item.weekStartsAt, at(addDays(TODAY, 14), '00:00'), 'the week does not start from the stored anchor');
    assert.equal(item.goalTitle, 'بدي أنزل بالوزن'); // I want to lose weight

    const stranger = await call('goals/plans/upcoming', 'GET', {}, undefined, OTHER);
    assert.deepEqual(stranger.body.items, [], 'another account sees this plan');

    h.setTime(at(addDays(TODAY, 14 + 15), '10:00'));
    const old = await call('goals/plans/upcoming', 'GET', {});
    assert.deepEqual(old.body.items, [], 'a week that started more than 14 days ago is still on Today');
  }, h);
});

test('M3A-026 the weeks count from the approval anchor, not from a later clock', async () => {
  const h = await setup();
  await within(async () => {
    await confirmed(h.goalId);
    h.setTime(at(addDays(TODAY, 6), '23:30'));
    const before = await call('goals/plans/upcoming', 'GET', {});
    assert.deepEqual(before.body.items, [], 'week 3 surfaced before day 8 of the anchor');
    h.setTime(at(addDays(TODAY, 7), '00:30'));
    const after = await call('goals/plans/upcoming', 'GET', {});
    assert.equal(after.body.items.length, 1, 'week 3 did not surface 7 days before its anchored start');
  }, h);
});

test('M3A-012 M3A-041 a later week is placed and confirmed on its own, and the first confirm still replays as it was', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times: first, answer: firstAnswer, k: firstKey } = await confirmed(h.goalId);
    const weighId = stepByTitle(plan, WEIGH).stepId;
    h.setTime(at(addDays(TODAY, 14), '10:00'));

    const later = await call('goals/[goalId]/plans/[planId]/later/[weekIndex]/times', 'POST',
      { goalId: h.goalId, planId: plan.planId, weekIndex: '3' }, { idempotencyKey: key('later') });
    assert.equal(later.status, 200, JSON.stringify(later.body));
    const times = later.body.times as Times;
    assert.deepEqual(times.steps.map((s) => s.stepId), [weighId], 'the later-week proposal is not only that week');
    const slot = stepTimes(times, weighId).slot!;
    assert.ok(slot, 'no slot for the week-3 step');
    assert.ok(Date.parse(slot.startsAt) >= Date.parse(at(addDays(TODAY, 14), '00:00')));
    assert.ok(Date.parse(slot.endsAt) <= Date.parse(at(addDays(TODAY, 21), '00:00')), 'a week-3 step placed outside week 3');

    const second = await confirm(h.goalId, times);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal((second.body.saved as Array<{ stepId: string }>).map((s) => s.stepId).join(), weighId);
    const upcoming = await call('goals/plans/upcoming', 'GET', {});
    assert.deepEqual(upcoming.body.items, []);

    const replay = await confirm(h.goalId, first, firstKey);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.saved, firstAnswer.saved);
    assert.deepEqual(replay.body.stayed, firstAnswer.stayed, 'the first outcome was rewritten by the later batch');
  }, h);
});

test('M3A-004 R5-004 a later week whose calendar changed before its confirm comes back with that week only', async () => {
  const h = await setup();
  await within(async () => {
    const { plan } = await confirmed(h.goalId);
    const weighId = stepByTitle(plan, WEIGH).stepId;
    h.setTime(at(addDays(TODAY, 14), '10:00'));
    const later = await call('goals/[goalId]/plans/[planId]/later/[weekIndex]/times', 'POST',
      { goalId: h.goalId, planId: plan.planId, weekIndex: '3' }, { idempotencyKey: key('later') });
    assert.equal(later.status, 200, JSON.stringify(later.body));
    const times = later.body.times as Times;
    const slot = stepTimes(times, weighId).slot!;
    await addBusy(slot);
    const before = (await commitments()).length;

    const answer = await confirm(h.goalId, times);
    assert.equal(answer.status, 409, JSON.stringify(answer.body));
    assert.equal(answer.body.reason, 'schedule_changed');
    const fresh = answer.body.times as Times;
    assert.deepEqual(fresh.steps.map((s) => s.stepId), [weighId], 'the recomputed later-week proposal is not that week only');
    const moved = stepTimes(fresh, weighId).slot;
    assert.ok(!moved || !overlaps(moved, slot), 'the recomputed slot still clashes');
    assert.equal((await commitments()).length, before, 'a refused confirm wrote');
  }, h);
});

test('M3A-006 R5-005 a time change lands on the proposal that was reviewed, never on a newer one', async () => {
  const h = await setup();
  await within(async () => {
    const { plan } = await confirmed(h.goalId);
    const weighId = stepByTitle(plan, WEIGH).stepId;
    h.setTime(at(addDays(TODAY, 14), '10:00'));
    const place = async () => {
      const answer = await call('goals/[goalId]/plans/[planId]/later/[weekIndex]/times', 'POST',
        { goalId: h.goalId, planId: plan.planId, weekIndex: '3' }, { idempotencyKey: key('later') });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body.times as Times;
    };
    // Two devices place the same week; the first keeps reviewing its own proposal.
    const older = await place();
    // A minute later, so the second proposal is really the newer one.
    h.setTime(at(addDays(TODAY, 14), '10:01'));
    const newer = await place();
    assert.notEqual(older.timesId, newer.timesId);

    const answer = await choose(h.goalId, older, weighId, { none: true });
    if (answer.status === 200) {
      assert.equal((answer.body.times as Times).timesId, older.timesId, 'the choice landed on another proposal than the one reviewed');
    } else {
      assert.equal(answer.status, 409, JSON.stringify(answer.body));
      assert.equal(answer.body.reason, 'stale');
    }
    // The newer proposal is as it was placed: confirming it saves its own slot.
    const confirmedNewer = await confirm(h.goalId, newer);
    assert.equal(confirmedNewer.status, 200, JSON.stringify(confirmedNewer.body));
    const saved = (confirmedNewer.body.saved as Array<{ stepId: string; when: Record<string, unknown> }>).find((s) => s.stepId === weighId);
    assert.deepEqual(saved?.when, { kind: 'slot', ...stepTimes(newer, weighId).slot! }, 'the newer proposal was changed by a choice made on the older one');
  }, h);
});

test('M3A-033 the card answers 404 feature_unavailable when the module is off', async () => {
  const h = await setup({ env: { MAYBESITTER_FEATURE_GOAL_PLAN: 'false' } });
  await within(async () => {
    const answer = await call('goals/plans/upcoming', 'GET', {});
    assert.equal(answer.status, 404);
    assert.equal(answer.body.reason, 'feature_unavailable');
  }, h);
});

/* ── the statement entry (acceptance 5, M3A-005, -019, -043) ───────── */

test('A5 M3A-005 a statement is previewed, then accepted once as a goal; the preview is deleted', async () => {
  const h = await setup({ model: false });
  await within(async () => {
    const preview = await call('goals/from-statement/preview', 'POST', {}, { statement: 'بدي أرجع أركض', locale: 'ar' }); // I want to run again
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const { summaryId, revision, understood, expiresAt } = preview.body;
    assert.ok(summaryId && typeof revision === 'number' && understood?.goalText);
    assert.equal(Date.parse(expiresAt) - Date.now(), 30 * 60_000);

    const k = key('accept');
    const accepted = await call('goals/from-statement/accept', 'POST', {}, { summaryId, revision, understood, idempotencyKey: k });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const goalId = accepted.body.goalId as string;
    assert.ok((await getStorage().list(userCol(USER, MEMORY))).some((row) => JSON.stringify(row.data).includes(understood.goalText)),
      'the goal was not saved as a memory record');

    const again = await call('goals/from-statement/accept', 'POST', {}, { summaryId, revision, understood, idempotencyKey: k });
    assert.equal(again.status, 200);
    assert.equal(again.body.goalId, goalId, 'a retried accept made a second goal');
    const changed = await call('goals/from-statement/accept', 'POST', {},
      { summaryId, revision, understood: { goalText: 'إشي تاني' }, idempotencyKey: k }); // something else
    assert.equal(changed.status, 409);

    const left = [];
    for (const collection of USER_SCOPED_COLLECTIONS) {
      for (const row of await getStorage().list(userCol(USER, collection))) if (JSON.stringify(row.data).includes(summaryId)) left.push(collection);
    }
    assert.deepEqual(left.filter((c) => c !== MEMORY), [], 'the accepted preview was kept');
  }, h);
});

test('M3A-043 a preview carries a storage TTL at its expiry', async () => {
  const h = await setup({ model: false });
  await within(async () => {
    const preview = await call('goals/from-statement/preview', 'POST', {}, { statement: 'بدي أرجع أركض', locale: 'ar' }); // I want to run again
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    let doc: Record<string, any> | undefined;
    for (const collection of USER_SCOPED_COLLECTIONS) {
      for (const row of await getStorage().list<Record<string, any>>(userCol(USER, collection))) {
        if (JSON.stringify(row.data).includes(preview.body.summaryId)) doc = row.data;
      }
    }
    assert.ok(doc, 'the preview is not stored in a user-scoped collection');
    const ttl = Object.entries(doc!).find(([name]) => /expire|ttl/i.test(name));
    assert.ok(ttl, `the preview has no TTL field: ${Object.keys(doc!).join(', ')}`);
  }, h);
});

test('A5 M3A-019 an appointment is not forced into a plan: 422 not_a_goal with recovery capture', async () => {
  const h = await setup({ model: false });
  await within(async () => {
    const answer = await call('goals/from-statement/preview', 'POST', {}, { statement: 'موعد دكتور بكرا الساعة 4', locale: 'ar' }); // a doctor's appointment tomorrow at 4
    assert.equal(answer.status, 422);
    assert.equal(answer.body.reason, 'not_a_goal');
    assert.equal(answer.body.classification, 'event');
    assert.equal(answer.body.recovery, 'capture');
    assert.equal((await getStorage().list(userCol(USER, MEMORY))).length, 1, 'a non-goal was saved as a goal');
  }, h);
});

/* ── «ابنيلي خطة» through «افهم» (M3A-032, -034) ───────────────────── */

const LOOP = { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' };

test('M3A-032 a plan imperative sent to «افهم» routes to the plan flow, in ar, en and he', async () => {
  const h = await setup({ env: LOOP });
  await within(async () => {
    for (const text of ['ابنيلي خطة أنزل بالوزن', 'make me a plan to run a 5k', 'תבנה לי תוכנית לרוץ']) { // build me a plan to lose weight / build me a plan to run
      const answer = await call('intelligence', 'POST', {}, { text });
      assert.equal(answer.body.route, 'plan_flow', `«${text}» was not routed: ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
    }
    const plain = await call('intelligence', 'POST', {}, { text: 'بحب أمشي الصبح' }); // I like walking in the morning
    assert.notEqual(plain.body.route, 'plan_flow', 'an ordinary statement was routed to the plan flow');
  }, h);
});

test('M3A-034 in production the plan imperative is analysed as before, never routed', async () => {
  const h = await setup({ env: { MAYBESITTER_ENV: 'production', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true', MAYBESITTER_FEATURE_GOAL_PLAN: 'true' } });
  await within(async () => {
    const answer = await call('intelligence', 'POST', {}, { text: 'ابنيلي خطة أنزل بالوزن' }); // build me a plan to lose weight
    assert.notEqual(answer.body.route, 'plan_flow');
  }, h);
  // On the gate base this passes vacuously: it guards the build, so it is
  // paired with the staging test above, which fails there.
});

/* ── moving a plan block (M3A-036, -047) ───────────────────────────── */

test('M3A-036 moving a saved plan step keeps its length', async () => {
  const h = await setup();
  await within(async () => {
    const { answer } = await confirmed(h.goalId);
    const walk = (answer.saved as Array<Record<string, any>>).find((s) => s.entity === 'commitment')!;
    const length = Date.parse(walk.when.endsAt) - Date.parse(walk.when.startsAt);
    for (const shift of [-3_600_000, 2 * 3_600_000]) {
      const current = (await commitments()).find((c) => c.id === walk.id)!;
      const dueDate = new Date(Date.parse(current.timeSpec.dueAt!) + shift).toISOString();
      const moved = await call('commitments/[id]', 'PATCH', { id: walk.id }, { dueDate });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      const after = (await commitments()).find((c) => c.id === walk.id)!;
      assert.equal(after.timeSpec.dueAt, dueDate);
      assert.equal(after.timeSpec.endAt, new Date(Date.parse(dueDate) + length).toISOString(), `a move by ${shift / 3_600_000}h changed the block’s length`);
    }
  }, h);
});

/* ── the daily plan's typed failures (acceptance 6, image 2) ───────── */

test('A6 «اعمل خطة اليوم»: a build that cannot finish answers a typed reason, never an untyped error', async () => {
  const h = await setup();
  await within(async () => {
    // Only the daily plan's own document fails, so auth and the other reads
    // still work and the failure is the build's, not the account's.
    const storage = getStorage() as unknown as Record<string, (...args: any[]) => Promise<unknown>>;
    const original = storage.runTransaction;
    storage.runTransaction = (fn: (tx: any) => Promise<unknown>) => original.call(storage, (tx: any) => fn(new Proxy(tx, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].includes(`/${PLANS}/`)) throw new Error('daily plan store unavailable');
          return value.apply(target, args);
        };
      },
    })));
    let answer: { status: number; body: Record<string, any> };
    try {
      answer = await call('plans/[date]/build', 'POST', { date: TODAY }).catch((error: Error) => ({ status: 500, body: { thrown: error.message } }));
    } finally {
      storage.runTransaction = original;
    }
    assert.ok(answer.status >= 400);
    assert.equal(typeof answer.body.reason, 'string', `the build failed with no reason: ${JSON.stringify(answer.body)}`);
    assert.ok(answer.body.reason.length > 0 && answer.body.reason !== 'unknown');
    assert.equal(typeof answer.body.retryable, 'boolean', `no retryable flag: ${answer.status} ${JSON.stringify(answer.body)}`);
  }, h);
});
