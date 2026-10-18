/**
 * M4b Gate B — a followed club's match never lands on a clash silently
 * (condition 24, owner decision D5; PLAN-M4b R1.1–R1.3, WIRE-M4b "Football").
 *
 * The real fixture store, follow list, projection and routes, memory storage,
 * the clock pinned to Wednesday 2026-10-07 10:00 Jerusalem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_MINUTES,
  addAllDayEvent,
  addDeviceBusy,
  addEvent,
  addTimedDeadline,
  addWeekly,
  allCommitments,
  at,
  begin,
  call,
  commitment,
  countReads,
  dropCommitment,
  end,
  fixture,
  fixtureCommitment,
  fixtureRef,
  follow,
  kickoff,
  localDateOf,
  moveCommitment,
  otherClubFixture,
  plusMinutes,
  project,
  putFixtures,
  raceAt,
  show,
  TODAY,
} from './support.ts';

test.afterEach(() => end());

const SAT_21 = () => kickoff(3, '21:00'); // Saturday 2026-10-10 21:00

async function heldList(uid: string): Promise<any[]> {
  const result = await call(uid, 'football', 'GET');
  assert.equal(result.status, 200, show(result.body));
  assert.ok(Array.isArray(result.body.held), `GET /football has no held[] with the capability on: ${show(result.body)}`);
  return result.body.held;
}

function heldPost(uid: string, fixtureId: string, body: Record<string, unknown>) {
  return call(uid, 'football/held/[fixtureId]', 'POST', { params: { fixtureId }, body });
}

/* ── R1.2: the projection decides before it writes ─────────────────── */

test('R1.2 parity: a match that clashes with nothing is saved as today', async () => {
  const uid = begin();
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  const saved = await fixtureCommitment(uid, '1');
  assert.ok(saved, 'a free match must still be saved automatically (D5: following is the consent)');
  assert.equal(saved.timeSpec.dueAt, SAT_21());
});

test('R1.2 D5: a match over a saved commitment is held, not saved', async () => {
  const uid = begin();
  await addEvent(uid, 'عشا العيلة', plusMinutes(SAT_21(), -30), plusMinutes(SAT_21(), 60)); // family dinner
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  assert.equal(await fixtureCommitment(uid, '1'), null, 'the clashing match was saved silently');
  const ref = await fixtureRef(uid, '1');
  assert.ok(ref, 'no ref was written for the held match');
  assert.equal(ref.linkState, 'candidate');
  assert.equal(ref.linkedCommitmentId, null);
  assert.equal(ref.held?.reason, 'clash', `ref.held: ${show(ref.held)}`);
  assert.ok(ref.held.clashes.some((c: any) => c.title === 'عشا العيلة' && c.kind === 'commitment'), show(ref.held.clashes));
});

test('M4B-REV-001: a match over a saved timed deadline is held (a fixed event clashes with a timed due_by)', async () => {
  const uid = begin();
  await addTimedDeadline(uid, 'سلّم التقرير', plusMinutes(SAT_21(), 30)); // hand in the report
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  assert.equal(await fixtureCommitment(uid, '1'), null);
  assert.equal((await fixtureRef(uid, '1'))?.held?.reason, 'clash');
});

test('M4B-REV-001 parity: an all-day item does not block a match', async () => {
  const uid = begin();
  await addAllDayEvent(uid, 'عطلة', localDateOf(SAT_21())); // a holiday
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  assert.ok(await fixtureCommitment(uid, '1'));
});

test('R1.2: device calendar busy time holds a match, and the clash has no title', async () => {
  const uid = begin();
  await addDeviceBusy(uid, [{ startsAt: plusMinutes(SAT_21(), 30), endsAt: plusMinutes(SAT_21(), 90) }]);
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  assert.equal(await fixtureCommitment(uid, '1'), null);
  const ref = await fixtureRef(uid, '1');
  assert.equal(ref?.held?.reason, 'clash');
  const busy = ref.held.clashes.find((c: any) => c.kind === 'calendar_busy');
  assert.ok(busy, show(ref.held.clashes));
  assert.equal(busy.title, null, 'a calendar busy clash must never get a title');
});

test('R1.2: a weekly block holds a match', async () => {
  const uid = begin();
  await addWeekly(uid, 'تمرين', [6], '20:00', '22:00'); // training, Saturdays
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  assert.equal(await fixtureCommitment(uid, '1'), null);
  const ref = await fixtureRef(uid, '1');
  assert.equal(ref?.held?.reason, 'clash');
  assert.ok(ref.held.clashes.some((c: any) => c.kind === 'weekly'), show(ref.held.clashes));
});

test('R1.2: a match outside a connected source\'s coverage waits (unknown), unsaved and unasked', async () => {
  const uid = begin();
  await addDeviceBusy(uid, [], { startsAt: at(TODAY, '00:00'), endsAt: kickoff(2, '00:00') });
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  assert.equal(await fixtureCommitment(uid, '1'), null, 'an unverifiable match was saved');
  assert.equal((await fixtureRef(uid, '1'))?.held?.reason, 'unknown');
  const result = await call(uid, 'football', 'GET');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.held, [], 'an unknown hold must not be asked about');
  assert.ok(result.body.waitingForCoverage >= 1, `waitingForCoverage: ${show(result.body.waitingForCoverage)}`);
});

test('R1.2 parity-by-design (base saves every match): an unknown hold is saved once coverage arrives and the time is free', async () => {
  const uid = begin();
  await addDeviceBusy(uid, [], { startsAt: at(TODAY, '00:00'), endsAt: kickoff(2, '00:00') });
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  await addDeviceBusy(uid, [], { startsAt: at(TODAY, '00:00'), endsAt: kickoff(20, '00:00') });
  await project(uid);
  assert.ok(await fixtureCommitment(uid, '1'), 'the match never entered the calendar after coverage arrived');
});

test('M4B-REV-003: two followed clubs at one hour — the second is held, never both saved', async () => {
  const uid = begin();
  await follow(uid, ['barcelona', 'atletico-madrid']);
  await putFixtures(fixture('1', SAT_21()), otherClubFixture('2', SAT_21()));
  await project(uid);
  const saved = [await fixtureCommitment(uid, '1'), await fixtureCommitment(uid, '2')].filter(Boolean);
  assert.equal(saved.length, 1, `both matches at one hour were saved: ${show(saved)}`);
});

test('M4B-REV-003: two saved matches both moved to 21:00 in one run — the second is held', async () => {
  const uid = begin();
  await follow(uid, ['barcelona', 'atletico-madrid']);
  await putFixtures(fixture('1', kickoff(3, '15:00')), otherClubFixture('2', kickoff(3, '18:00')));
  await project(uid);
  assert.ok(await fixtureCommitment(uid, '1'));
  assert.ok(await fixtureCommitment(uid, '2'));
  await putFixtures(fixture('1', SAT_21()), otherClubFixture('2', SAT_21()));
  await project(uid);
  const active = (await allCommitments(uid)).filter((c) => c.status === 'active' && c.timeSpec.dueAt === SAT_21());
  assert.equal(active.length, 1, `two matches now sit at 21:00: ${show(active.map((c) => c.title))}`);
});

test('R1.2 branch 5: a saved match moved onto a clash is dropped and held with moved: true', async () => {
  const uid = begin();
  await follow(uid);
  await putFixtures(fixture('1', kickoff(3, '15:00')));
  await project(uid);
  const before = await fixtureCommitment(uid, '1');
  assert.ok(before);
  await addEvent(uid, 'عرس', plusMinutes(SAT_21(), -60), plusMinutes(SAT_21(), 120)); // a wedding
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  const old = await commitment(uid, before.id);
  assert.equal(old.status, 'dropped', `the old-time commitment stayed: ${show(old.status)} ${show(old.timeSpec)}`);
  const ref = await fixtureRef(uid, '1');
  assert.equal(ref.held?.reason, 'clash');
  assert.equal(ref.droppedByProjection?.reason, 'moved_into_clash');
  const held = (await heldList(uid)).find((h) => h.fixtureId === 'football-data:1' || h.fixtureId === '1');
  assert.ok(held, 'the moved match is not asked about');
  assert.equal(held.moved, true);
  assert.equal(held.kickoffUtc, SAT_21());
});

test('R1.2 branch 5: an unknown move keeps the old commitment and never applies the move blind', async () => {
  const uid = begin();
  await addDeviceBusy(uid, [], { startsAt: at(TODAY, '00:00'), endsAt: kickoff(5, '00:00') });
  await follow(uid);
  await putFixtures(fixture('1', kickoff(3, '15:00')));
  await project(uid);
  const before = await fixtureCommitment(uid, '1');
  assert.ok(before);
  await putFixtures(fixture('1', kickoff(9, '21:00'))); // beyond device coverage
  await project(uid);
  const kept = await commitment(uid, before.id);
  assert.equal(kept.status, 'active');
  assert.equal(kept.timeSpec.dueAt, kickoff(3, '15:00'), 'the move was applied without knowing the new time is free');
});

test('M4B-REV-009: a held match is saved on the next run once the clashing commitment moves away', async () => {
  const uid = begin();
  const dinner = await addEvent(uid, 'عشا', plusMinutes(SAT_21(), -30), plusMinutes(SAT_21(), 60));
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  assert.equal(await fixtureCommitment(uid, '1'), null);
  await moveCommitment(uid, dinner, kickoff(4, '12:00'), kickoff(4, '13:00'));
  await project(uid);
  assert.ok(await fixtureCommitment(uid, '1'), 'the held match stayed stuck after its clash went away');
  assert.deepEqual(await heldList(uid), []);
});

test('R1.2: a dismissed held match never comes back, even when its clash goes away', async () => {
  const uid = begin();
  const dinner = await addEvent(uid, 'عشا', plusMinutes(SAT_21(), -30), plusMinutes(SAT_21(), 60));
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  const [held] = await heldList(uid);
  assert.ok(held);
  const dismissed = await heldPost(uid, held.fixtureId, { action: 'dismiss', expectedHeldVersion: held.heldVersion, clientActionId: '7a1e0000-0000-4000-8000-000000000001' });
  assert.equal(dismissed.status, 200, show(dismissed.body));
  await dropCommitment(uid, dinner);
  await project(uid);
  assert.equal(await fixtureCommitment(uid, '1'), null, 'a dismissed match was brought back');
});

test('R1.2: a cancelled match clears its hold without asking', async () => {
  const uid = begin();
  await addEvent(uid, 'عشا', plusMinutes(SAT_21(), -30), plusMinutes(SAT_21(), 60));
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  assert.equal((await heldList(uid)).length, 1);
  await putFixtures(fixture('1', SAT_21(), { status: 'cancelled' }));
  await project(uid);
  assert.deepEqual(await heldList(uid), []);
});

test('R1 risk: no schedule read on a run where nothing changes and nothing is held; one while a hold exists', async () => {
  const uid = begin();
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  const quiet = await countReads(() => project(uid));
  assert.equal(quiet.reads, 0, `a no-change run read the schedule ${quiet.reads} times`);
  await addEvent(uid, 'عشا', plusMinutes(kickoff(4, '21:00'), -30), plusMinutes(kickoff(4, '21:00'), 60));
  await putFixtures(fixture('2', kickoff(4, '21:00')));
  await project(uid);
  const holding = await countReads(() => project(uid));
  assert.ok(holding.reads >= 1, 'a run with a held match must re-read the schedule (M4B-REV-009)');
  assert.ok(holding.reads <= 1, `a held-only run read the full schedule ${holding.reads} times (at most once per run)`);
});

/* ── M4B-R2-002: the decision is inside the write's transaction ──────── */

test('M4B-R2-002: a commitment confirmed mid-decision holds the match (never saved over it)', async () => {
  const uid = begin();
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  const release = await raceAt('football', async () => {
    await addEvent(uid, 'زيارة', plusMinutes(SAT_21(), 15), plusMinutes(SAT_21(), 75)); // a visit
  });
  try { await project(uid); } finally { release(); }
  assert.equal(await fixtureCommitment(uid, '1'), null, 'the match was saved over a commitment written during the decision');
});

test('M4B-R2-002: device busy time uploaded mid-decision holds the match', async () => {
  const uid = begin();
  await addDeviceBusy(uid, []);
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  const release = await raceAt('football', async () => {
    await addDeviceBusy(uid, [{ startsAt: plusMinutes(SAT_21(), 15), endsAt: plusMinutes(SAT_21(), 75) }]);
  });
  try { await project(uid); } finally { release(); }
  assert.equal(await fixtureCommitment(uid, '1'), null);
});

test('M4B-R2-002: a weekly block created mid-decision holds the match', async () => {
  const uid = begin();
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  const release = await raceAt('football', async () => {
    await addWeekly(uid, 'تمرين', [6], '20:30', '22:00');
  });
  try { await project(uid); } finally { release(); }
  assert.equal(await fixtureCommitment(uid, '1'), null);
});

/* ── R1.3: asking, adding, dismissing ───────────────────────────────── */

async function heldOverDinner(uid: string) {
  await addEvent(uid, 'عشا العيلة', plusMinutes(SAT_21(), -30), plusMinutes(SAT_21(), 60));
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  const list = await heldList(uid);
  assert.equal(list.length, 1, show(list));
  return list[0];
}

test('R1.3 WIRE: a held match has its version, its times and its clashes', async () => {
  const uid = begin();
  const held = await heldOverDinner(uid);
  assert.equal(typeof held.heldVersion, 'string');
  assert.equal(held.kickoffUtc, SAT_21());
  assert.equal(held.endUtc, plusMinutes(SAT_21(), FIXTURE_MINUTES));
  assert.equal(held.moved, false);
  assert.ok(held.clashes.length >= 1 && held.clashes[0].title === 'عشا العيلة', show(held.clashes));
});

test('R1.3: «ضيفه» saves the match knowingly and keeps its clash on the fixture (M4B-R3-005)', async () => {
  const uid = begin();
  const held = await heldOverDinner(uid);
  const added = await heldPost(uid, held.fixtureId, { action: 'add', expectedHeldVersion: held.heldVersion, clientActionId: '7a1e0000-0000-4000-8000-000000000002' });
  assert.equal(added.status, 200, show(added.body));
  assert.equal(added.body.action, 'add');
  assert.ok(await fixtureCommitment(uid, '1'), 'add did not save the match');
  assert.ok(added.body.fixture?.clashes?.some((c: any) => c.title === 'عشا العيلة'), `the consented clash vanished: ${show(added.body.fixture)}`);
  assert.deepEqual(await heldList(uid), []);
  const replay = await heldPost(uid, held.fixtureId, { action: 'add', expectedHeldVersion: held.heldVersion, clientActionId: '7a1e0000-0000-4000-8000-000000000002' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((await allCommitments(uid)).filter((c) => c.status === 'active' && c.timeSpec.dueAt === SAT_21()).length, 1, 'a replay saved the match twice');
});

test('M4B-R3-005: «ضيفه» over device busy time returns the null-title clash', async () => {
  const uid = begin();
  await addDeviceBusy(uid, [{ startsAt: plusMinutes(SAT_21(), 30), endsAt: plusMinutes(SAT_21(), 90) }]);
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  const [held] = await heldList(uid);
  const added = await heldPost(uid, held.fixtureId, { action: 'add', expectedHeldVersion: held.heldVersion, clientActionId: '7a1e0000-0000-4000-8000-000000000003' });
  assert.equal(added.status, 200, show(added.body));
  assert.ok(added.body.fixture?.clashes?.some((c: any) => c.kind === 'calendar_busy' && c.title === null), show(added.body.fixture));
});

test('M4B-R2-001: «ضيفه» on a hold whose time moved since it was read → 409 held_changed, nothing saved', async () => {
  const uid = begin();
  const held = await heldOverDinner(uid);
  await addEvent(uid, 'شغل', plusMinutes(kickoff(4, '22:00'), -30), plusMinutes(kickoff(4, '22:00'), 60)); // keeps the moved match held
  await putFixtures(fixture('1', kickoff(4, '22:00')));
  await project(uid);
  const stale = await heldPost(uid, held.fixtureId, { action: 'add', expectedHeldVersion: held.heldVersion, clientActionId: '7a1e0000-0000-4000-8000-000000000004' });
  assert.equal(stale.status, 409, show(stale.body));
  assert.equal(stale.body.error, 'held_changed');
  assert.equal(stale.body.held?.kickoffUtc, kickoff(4, '22:00'));
  assert.equal(await fixtureCommitment(uid, '1'), null);
});

test('M4B-R5-003: «ضيفه» when the clash set changed since it was read → 409 held_changed', async () => {
  const uid = begin();
  const held = await heldOverDinner(uid);
  await addEvent(uid, 'اجتماع', plusMinutes(SAT_21(), 60), plusMinutes(SAT_21(), 100)); // a meeting, not yet seen by the projection
  const changed = await heldPost(uid, held.fixtureId, { action: 'add', expectedHeldVersion: held.heldVersion, clientActionId: '7a1e0000-0000-4000-8000-000000000005' });
  assert.equal(changed.status, 409, `add accepted consent for an obsolete clash set: ${show(changed.body)}`);
  assert.equal(changed.body.error, 'held_changed');
  assert.equal(await fixtureCommitment(uid, '1'), null);
});

test('M4B-R5-003: «ضيفه» when the clash is gone simply saves the match', async () => {
  const uid = begin();
  await addEvent(uid, 'عشا العيلة', plusMinutes(SAT_21(), -30), plusMinutes(SAT_21(), 60));
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  const [held] = await heldList(uid);
  const dinner = (await allCommitments(uid)).find((c) => c.title === 'عشا العيلة');
  await dropCommitment(uid, dinner.id);
  const added = await heldPost(uid, held.fixtureId, { action: 'add', expectedHeldVersion: held.heldVersion, clientActionId: '7a1e0000-0000-4000-8000-000000000006' });
  assert.equal(added.status, 200, show(added.body));
  assert.ok(await fixtureCommitment(uid, '1'));
});

test('M4B-R5-003: a commitment written at the tap is seen by the add transaction', async () => {
  const uid = begin();
  const held = await heldOverDinner(uid);
  const release = await raceAt('heldAdd', async () => {
    await addEvent(uid, 'زيارة', plusMinutes(SAT_21(), 70), plusMinutes(SAT_21(), 110));
  });
  let result;
  try {
    result = await heldPost(uid, held.fixtureId, { action: 'add', expectedHeldVersion: held.heldVersion, clientActionId: '7a1e0000-0000-4000-8000-000000000007' });
  } finally { release(); }
  assert.equal(result.status, 409, show(result.body));
  assert.equal(result.body.error, 'held_changed');
});

test('R1.3 WIRE: a reused clientActionId with another body → key_reused', async () => {
  const uid = begin();
  const held = await heldOverDinner(uid);
  const key = '7a1e0000-0000-4000-8000-000000000008';
  assert.equal((await heldPost(uid, held.fixtureId, { action: 'dismiss', expectedHeldVersion: held.heldVersion, clientActionId: key })).status, 200);
  const reused = await heldPost(uid, held.fixtureId, { action: 'add', expectedHeldVersion: held.heldVersion, clientActionId: key });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, 'key_reused');
});

test('M4B-R3-004: an unchanged hold keeps its version across runs; a changed clash changes it', async () => {
  const uid = begin();
  const first = await heldOverDinner(uid);
  for (let run = 0; run < 10; run += 1) await project(uid);
  const [again] = await heldList(uid);
  assert.equal(again.heldVersion, first.heldVersion, 'a periodic re-evaluation changed the version of an identical hold');
  await addEvent(uid, 'اجتماع', plusMinutes(SAT_21(), 60), plusMinutes(SAT_21(), 100));
  await project(uid);
  const [changed] = await heldList(uid);
  assert.notEqual(changed.heldVersion, first.heldVersion);
});

test('R1.3: the held summary lists clash holds only, with a true count', async () => {
  const uid = begin();
  await heldOverDinner(uid);
  const result = await call(uid, 'held-items', 'GET');
  assert.equal(result.status, 200, show(result.body));
  assert.equal(result.body.count, 1);
  assert.equal(result.body.items[0].source, 'football');
  assert.equal(result.body.items[0].startsAt, SAT_21());
});

test('M4B-R4-005: an accepted held match keeps its clashes (clashState unknown) when coverage lapses', async () => {
  const uid = begin();
  await addDeviceBusy(uid, [{ startsAt: plusMinutes(SAT_21(), 30), endsAt: plusMinutes(SAT_21(), 90) }]);
  await follow(uid);
  await putFixtures(fixture('1', SAT_21()));
  await project(uid);
  const [held] = await heldList(uid);
  assert.equal((await heldPost(uid, held.fixtureId, { action: 'add', expectedHeldVersion: held.heldVersion, clientActionId: '7a1e0000-0000-4000-8000-000000000009' })).status, 200);
  await addDeviceBusy(uid, [], { startsAt: at(TODAY, '00:00'), endsAt: kickoff(1, '00:00') });
  const result = await call(uid, 'football', 'GET');
  assert.equal(result.status, 200, 'the fixture response failed because coverage lapsed');
  const row = result.body.fixtures.find((f: any) => f.kickoffUtc === SAT_21());
  assert.ok(row, show(result.body.fixtures));
  assert.equal(row.clashState, 'unknown');
  assert.ok(row.clashes?.some((c: any) => c.kind === 'calendar_busy'), `the consented clash was lost: ${show(row)}`);
});

/* ── release ────────────────────────────────────────────────────────── */

for (const [name, switches] of [['off', { hold: false }], ['killed', { holdKilled: true }]] as const) {
  test(`R1 release parity (${name}): a clashing match is saved exactly as today, and no hold surfaces exist`, async () => {
    const uid = begin(switches);
    await addEvent(uid, 'عشا', plusMinutes(SAT_21(), -30), plusMinutes(SAT_21(), 60));
    await follow(uid);
    await putFixtures(fixture('1', SAT_21()));
    const { reads } = await countReads(() => project(uid));
    assert.ok(await fixtureCommitment(uid, '1'), 'flag off must keep today\'s behaviour');
    assert.equal(reads, 0, 'flag off must not read the schedule');
    const get = await call(uid, 'football', 'GET');
    assert.equal(get.status, 200);
    assert.equal('held' in get.body, false, 'flag off must not add held[]');
  });

  test(`R1.3 release (${name}): the held routes answer 404 feature_unavailable`, async () => {
    const uid = begin(switches);
    const post = await heldPost(uid, 'football-data:1', { action: 'add', expectedHeldVersion: 'x', clientActionId: '7a1e0000-0000-4000-8000-00000000000a' });
    assert.equal(post.status, 404);
    assert.equal(post.body.error, 'feature_unavailable');
    const items = await call(uid, 'held-items', 'GET');
    assert.equal(items.status, 404);
    assert.equal(items.body.error, 'feature_unavailable');
  });
}

test('R1.2 callers: the follow PUT holds a clashing match and says nothing was saved over the clash', async () => {
  const uid = begin();
  await addEvent(uid, 'عشا', plusMinutes(SAT_21(), -30), plusMinutes(SAT_21(), 60));
  await putFixtures(fixture('1', SAT_21()));
  // A server that holds the match data key (closure CL7); nothing here fetches.
  const previousKey = process.env.FOOTBALL_DATA_API_KEY;
  process.env.FOOTBALL_DATA_API_KEY = 'test-key';
  let put;
  try {
    put = await call(uid, 'football', 'PUT', { body: { clubIds: ['barcelona'] } });
  } finally {
    if (previousKey === undefined) delete process.env.FOOTBALL_DATA_API_KEY;
    else process.env.FOOTBALL_DATA_API_KEY = previousKey;
  }
  assert.equal(put.status, 200, show(put.body));
  assert.equal(await fixtureCommitment(uid, '1'), null);
  assert.equal(put.body.held?.length, 1, `the follow answer must carry the held match: ${show(put.body.held)}`);
});

/* ── review findings (Claude's hand review of Task B) ───────────────── */

test('REVIEW B-1: a match past the weekly blocks\' materialised horizon is not saved over a weekly block', async () => {
  const uid = begin();
  const day58 = kickoff(58, '21:00'); // the projection window is 60 days; weekly occurrences are materialised 8 weeks
  const weekday = new Date(Date.parse(day58) + 3 * 3_600_000).getUTCDay(); // its local weekday (Jerusalem is UTC+2/3)
  await addWeekly(uid, 'تمرين', [weekday], '20:00', '23:00'); // training, every week on that day
  await follow(uid);
  await putFixtures(fixture('1', day58));
  await project(uid);
  assert.equal(await fixtureCommitment(uid, '1'), null, 'a match was saved over a weekly block beyond its materialised occurrences');
});
