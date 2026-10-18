/**
 * M4b Gate B — an evening that can hurt the next morning (condition 25, owner
 * decision D6; PLAN-M4b R2.1–R2.2, WIRE-M4b "R2").
 *
 * The rules path (no model), real routes in-process, memory storage, the clock
 * pinned to Wednesday 2026-10-07 10:00 Jerusalem. Thursday is 2026-10-08,
 * Friday 2026-10-09. The parses below were probed on 971bd421: «سهرة الخميس
 * الساعة 9 بالليل» → Thu 21:00 with no end; «… من الساعة 21:00 للساعة 23:30»
 * → 21:00–23:30; «امتحان رياضيات الجمعة 9 الصبح» → Fri 09:00.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addAllDayEvent,
  addEvent,
  allCommitments,
  at,
  begin,
  call,
  confirmProposal,
  dropCommitment,
  end,
  moveCommitment,
  postponeLegacy,
  raceAt,
  say,
  show,
  addWeekly,
  overlaps,
} from './support.ts';

test.afterEach(() => end());

const THU = '2026-10-08';
const FRI = '2026-10-09';
const EVENING_NO_END = 'سهرة الخميس الساعة 9 بالليل'; // an evening out, Thursday 9 pm
const EVENING_TO_2330 = 'عندي سهرة الخميس من الساعة 21:00 للساعة 23:30'; // Thursday 21:00–23:30
const EVENING_TO_22 = 'عرس ابن عمي الخميس من 8 المسا لل 10'; // a wedding, Thursday 20:00–22:00
const EVENING_AT_8 = 'سهرة الخميس الساعة 8 المسا'; // Thursday 20:00, no end
const EXAM_AR = 'امتحان رياضيات'; // maths exam
const EXAM_FRI_9 = 'امتحان رياضيات الجمعة 9 الصبح'; // maths exam Friday 9 am

function itemTitled(answer: any, words: string): any {
  const item = answer.proposal?.items.find((candidate: any) => candidate.title.includes(words));
  assert.ok(item, `no item «${words}»: ${show(answer.proposal)}`);
  return item;
}

function impactOf(item: any): any {
  assert.ok(Array.isArray(item.impacts) && item.impacts.length === 1, `expected one impact on «${item.title}»: ${show(item)}`);
  return item.impacts[0];
}

function noImpact(item: any): void {
  assert.equal(item.impacts, undefined, `«${item.title}» must carry no impacts field: ${show(item.impacts)}`);
}

function answerImpact(uid: string, proposal: any, itemId: string, readiness: string, revision = proposal.revision ?? 0) {
  return call(uid, 'capture/impact', 'POST', { body: { proposalId: proposal.proposalId, revision, itemId, readiness } });
}

/* ── R2.1: the rule ─────────────────────────────────────────────────── */

test('R2.1 D6: an evening starting at 21:00 with no end, before a Friday 09:00 exam, is warned on the evening card', async () => {
  const uid = begin();
  await addEvent(uid, EXAM_AR, at(FRI, '09:00'), at(FRI, '11:00'));
  const answer = await say(uid, EVENING_NO_END);
  const impact = impactOf(itemTitled(answer, 'سهرة'));
  assert.equal(impact.kind, 'late_before_important');
  assert.equal(impact.role, 'evening');
  assert.equal(impact.otherTitle, EXAM_AR);
  assert.equal(impact.otherStartsAt, at(FRI, '09:00'));
  assert.equal(impact.readiness, null);
  assert.equal(impact.prep, null);
});

test('R2.1 D6: an evening with an explicit end after 22:00 is warned', async () => {
  const uid = begin();
  await addEvent(uid, EXAM_AR, at(FRI, '09:00'));
  impactOf(itemTitled(await say(uid, EVENING_TO_2330), 'سهرة'));
});

test('R2.1 boundary: an evening that ends exactly at 22:00 is not late', async () => {
  const uid = begin();
  await addEvent(uid, EXAM_AR, at(FRI, '09:00'));
  noImpact(itemTitled(await say(uid, EVENING_TO_22), 'عرس'));
});

test('R2.1 boundary: an end-less evening starting at 20:00 is not late', async () => {
  const uid = begin();
  await addEvent(uid, EXAM_AR, at(FRI, '09:00'));
  noImpact(itemTitled(await say(uid, EVENING_AT_8), 'سهرة'));
});

test('R2.1 boundary: an important item at 12:00 is not "morning"; 11:30 is', async () => {
  const uid = begin();
  await addEvent(uid, 'مقابلة شغل', at(FRI, '12:00')); // job interview at noon
  noImpact(itemTitled(await say(uid, EVENING_NO_END), 'سهرة'));
  end();
  const uid2 = begin();
  await addEvent(uid2, 'مقابلة شغل', at(FRI, '11:30'));
  assert.equal(impactOf(itemTitled(await say(uid2, EVENING_NO_END), 'سهرة')).otherTitle, 'مقابلة شغل');
});

test('R2.1: a morning item that is not a prepared event is ignored', async () => {
  const uid = begin();
  await addEvent(uid, 'فطور مع صحابي', at(FRI, '09:00')); // breakfast with friends
  noImpact(itemTitled(await say(uid, EVENING_NO_END), 'سهرة'));
});

test('M4B-R2-006: an all-day exam is not a morning item', async () => {
  const uid = begin();
  await addAllDayEvent(uid, EXAM_AR, FRI);
  noImpact(itemTitled(await say(uid, EVENING_NO_END), 'سهرة'));
});

test('R2.1: a dropped exam does not count', async () => {
  const uid = begin();
  const exam = await addEvent(uid, EXAM_AR, at(FRI, '09:00'));
  await dropCommitment(uid, exam);
  noImpact(itemTitled(await say(uid, EVENING_NO_END), 'سهرة'));
});

test('M4B-R3-007: a saved exam postponed (legacy) to 14:00 is no longer a morning item', async () => {
  const uid = begin();
  const exam = await addEvent(uid, EXAM_AR, at(FRI, '09:00'), at(FRI, '11:00'));
  await postponeLegacy(uid, exam, at(FRI, '14:00'));
  noImpact(itemTitled(await say(uid, EVENING_NO_END), 'سهرة'));
});

test('R2.2 both directions: the exam captured second is warned on the exam card', async () => {
  const uid = begin();
  await addEvent(uid, 'سهرة', at(THU, '21:00'), at(THU, '23:30'));
  const impact = impactOf(itemTitled(await say(uid, EXAM_FRI_9), 'امتحان'));
  assert.equal(impact.role, 'important');
  assert.equal(impact.otherTitle, 'سهرة');
  assert.equal(impact.otherStartsAt, at(THU, '21:00'));
});

test('M4B-R3-007: a saved evening postponed (legacy) into 23:00 now counts', async () => {
  const uid = begin();
  const evening = await addEvent(uid, 'سهرة', at(THU, '18:00'), at(THU, '19:00'));
  await postponeLegacy(uid, evening, at(THU, '23:00'));
  assert.equal(impactOf(itemTitled(await say(uid, EXAM_FRI_9), 'امتحان')).role, 'important');
});

test('R2.2: an evening and an exam in one message — the line is on the evening card, marked in-proposal', async () => {
  const uid = begin();
  // Probed on 971bd421: this phrasing splits into two items (a bare «و» merges them).
  const answer = await say(uid, 'عندي سهرة الخميس الساعة 9 بالليل، وعندي امتحان رياضيات الجمعة 9 الصبح');
  const impact = impactOf(itemTitled(answer, 'سهرة'));
  assert.equal(impact.role, 'evening');
  assert.equal(impact.otherInProposal, true);
  noImpact(itemTitled(answer, 'امتحان'));
});

/* ── R2.2: the readiness answer ─────────────────────────────────────── */

async function warned(uid: string): Promise<{ answer: any; evening: any }> {
  await addEvent(uid, EXAM_AR, at(FRI, '09:00'), at(FRI, '11:00'));
  const answer = await say(uid, EVENING_NO_END);
  const evening = itemTitled(answer, 'سهرة');
  impactOf(evening);
  return { answer, evening };
}

function prepItem(proposal: any): any {
  return proposal.items.find((item: any) => item.generated?.kind === 'evening_impact_prep');
}

test('R2.2: «جاهز» records the answer and adds nothing', async () => {
  const uid = begin();
  const { answer, evening } = await warned(uid);
  const result = await answerImpact(uid, answer.proposal, evening.itemId, 'ready');
  assert.equal(result.status, 200, show(result.body));
  const after = result.body.items.find((item: any) => item.itemId === evening.itemId);
  assert.equal(impactOf(after).readiness, 'ready');
  assert.equal(prepItem(result.body), undefined);
  assert.equal(result.body.items.length, answer.proposal.items.length);
});

for (const readiness of ['not_ready', 'unsure'] as const) {
  test(`R2.2 D6: «${readiness}» adds a 60-minute free preparation item before the evening`, async () => {
    const uid = begin();
    const { answer, evening } = await warned(uid);
    const result = await answerImpact(uid, answer.proposal, evening.itemId, readiness);
    assert.equal(result.status, 200, show(result.body));
    const prep = prepItem(result.body);
    assert.ok(prep, `no generated prep item: ${show(result.body.items)}`);
    assert.equal(prep.generated.sourceItemId, evening.itemId);
    const impact = impactOf(result.body.items.find((item: any) => item.itemId === evening.itemId));
    assert.equal(impact.readiness, readiness);
    assert.deepEqual(impact.prep, { state: 'offered', itemId: prep.itemId });
    assert.ok(prep.resolvedTime, show(prep));
    assert.ok(Date.parse(prep.resolvedTime) + 60 * 60_000 <= Date.parse(at(THU, '21:00')), `prep does not end before the evening: ${show(prep)}`);
    assert.ok(Date.parse(prep.resolvedTime) >= Date.parse(at('2026-10-07', '11:00')), 'prep before now + 60 minutes');
    assert.equal(Date.parse(prep.endTime) - Date.parse(prep.resolvedTime), 60 * 60_000, show(prep));
  });
}

test('M4B-REV-004: the prep item is saved as a real commitment by the ordinary confirm', async () => {
  const uid = begin();
  const { answer, evening } = await warned(uid);
  const result = await answerImpact(uid, answer.proposal, evening.itemId, 'not_ready');
  assert.equal(result.status, 200, show(result.body));
  const prep = prepItem(result.body);
  const confirmed = await confirmProposal(uid, result.body, [evening.itemId, prep.itemId], 'm4b-prep-1');
  assert.equal(confirmed.status, 200, show(confirmed.body));
  const saved = (await allCommitments(uid)).find((c) => c.timeSpec?.dueAt === prep.resolvedTime && c.title !== 'سهرة');
  assert.ok(saved, `the prep item was not written to the domain: ${show(await allCommitments(uid))}`);
  assert.equal(saved.timeSpec.endAt, prep.endTime);
  for (const id of confirmed.body.persistedItemIds ?? []) {
    assert.ok([evening.itemId, prep.itemId].includes(id), `persistedItemIds names an item not written: ${id}`);
  }
});

test('R2.2: «لسا لا» then «جاهز» removes an unedited prep item', async () => {
  const uid = begin();
  const { answer, evening } = await warned(uid);
  const first = await answerImpact(uid, answer.proposal, evening.itemId, 'not_ready');
  assert.ok(prepItem(first.body));
  const second = await answerImpact(uid, first.body, evening.itemId, 'ready');
  assert.equal(second.status, 200, show(second.body));
  assert.equal(prepItem(second.body), undefined, 'the unedited prep item stayed');
  assert.equal(impactOf(second.body.items.find((item: any) => item.itemId === evening.itemId)).prep, null);
});

test('R2.2: no free time before the evening → prep no_slot, nothing added', async () => {
  const uid = begin();
  await addEvent(uid, 'شغل', at('2026-10-07', '10:30'), at('2026-10-07', '22:00')); // work, all of today
  await addEvent(uid, 'شغل', at(THU, '07:00'), at(THU, '21:00')); // work, all of Thursday
  const { answer, evening } = await warned(uid);
  const result = await answerImpact(uid, answer.proposal, evening.itemId, 'not_ready');
  assert.equal(result.status, 200, show(result.body));
  assert.deepEqual(impactOf(result.body.items.find((item: any) => item.itemId === evening.itemId)).prep, { state: 'no_slot' });
  assert.equal(prepItem(result.body), undefined);
});

test('R2.2 WIRE: a stale revision → 409 proposal_changed with the current proposal', async () => {
  const uid = begin();
  const { answer, evening } = await warned(uid);
  const result = await answerImpact(uid, answer.proposal, evening.itemId, 'ready', (answer.proposal.revision ?? 0) + 7);
  assert.equal(result.status, 409, show(result.body));
  assert.equal(result.body.error, 'proposal_changed');
  assert.ok(result.body.proposal?.proposalId);
});

for (const [name, change] of [
  ['moved out of the morning', async (uid: string, id: string) => moveCommitment(uid, id, at(FRI, '15:00'), at(FRI, '17:00'))],
  ['dropped', async (uid: string, id: string) => dropCommitment(uid, id)],
] as const) {
  test(`M4B-R2-007: the saved exam ${name} before the tap → 409, the old answer never applied, no prep`, async () => {
    const uid = begin();
    const { answer, evening } = await warned(uid);
    const exam = (await allCommitments(uid)).find((c) => c.title === EXAM_AR);
    await change(uid, exam.id);
    const result = await answerImpact(uid, answer.proposal, evening.itemId, 'not_ready');
    assert.equal(result.status, 409, `a stale readiness answer was applied: ${show(result.body)}`);
    assert.equal(result.body.error, 'proposal_changed');
    const current = result.body.proposal.items.find((item: any) => item.itemId === evening.itemId);
    assert.equal(current.impacts, undefined, 'the stale impact was not removed');
    assert.equal(prepItem(result.body.proposal), undefined);
  });
}

test('M4B-R3-006: an impact that disappears takes its unedited prep item with it', async () => {
  const uid = begin();
  const { answer, evening } = await warned(uid);
  const first = await answerImpact(uid, answer.proposal, evening.itemId, 'not_ready');
  assert.ok(prepItem(first.body));
  const exam = (await allCommitments(uid)).find((c) => c.title === EXAM_AR);
  await dropCommitment(uid, exam.id);
  const again = await answerImpact(uid, first.body, evening.itemId, 'ready');
  assert.equal(again.status, 409, show(again.body));
  assert.equal(prepItem(again.body.proposal), undefined, 'an orphan prep item survived its impact');
  const confirmed = await confirmProposal(uid, again.body.proposal, again.body.proposal.items.map((item: any) => item.itemId), 'm4b-orphan-1');
  assert.equal(confirmed.status, 200, show(confirmed.body));
  assert.equal((await allCommitments(uid)).filter((c) => c.title.includes(EXAM_AR) && c.title !== EXAM_AR).length, 0, 'an orphan prep was persisted');
});

test('M4B-R5-004: a weekly block written mid-transaction is never covered by the prep item', async () => {
  const uid = begin();
  const { answer, evening } = await warned(uid);
  let blocked: { startsAt: string; endsAt: string } | null = null;
  const release = await raceAt('impact', async () => {
    await addWeekly(uid, 'نادي', [3, 4], '08:00', '20:30'); // a club, Wednesday and Thursday 08:00–20:30
    blocked = { startsAt: at(THU, '08:00'), endsAt: at(THU, '20:30') };
  });
  let result;
  try { result = await answerImpact(uid, answer.proposal, evening.itemId, 'not_ready'); } finally { release(); }
  assert.equal(result.status, 200, show(result.body));
  const prep = prepItem(result.body);
  if (prep) {
    assert.ok(blocked, 'the decision hook never fired at site "impact"');
    const interval = { startsAt: prep.resolvedTime, endsAt: prep.endTime };
    assert.ok(!overlaps(interval, blocked!), `prep placed over a block written mid-transaction: ${show(interval)}`);
    assert.ok(!overlaps(interval, { startsAt: at('2026-10-07', '08:00'), endsAt: at('2026-10-07', '20:30') }), show(interval));
  }
});

/* ── release ────────────────────────────────────────────────────────── */

for (const [name, switches] of [['off', { impact: false }], ['killed', { impactKilled: true }]] as const) {
  test(`R2 release (${name}): no impacts field and /capture/impact answers 404`, async () => {
    const uid = begin(switches);
    await addEvent(uid, EXAM_AR, at(FRI, '09:00'));
    const answer = await say(uid, EVENING_NO_END);
    noImpact(itemTitled(answer, 'سهرة'));
    const result = await answerImpact(uid, answer.proposal, itemTitled(answer, 'سهرة').itemId, 'ready');
    assert.equal(result.status, 404, show(result.body));
    assert.equal(result.body.error, 'feature_unavailable');
  });
}
