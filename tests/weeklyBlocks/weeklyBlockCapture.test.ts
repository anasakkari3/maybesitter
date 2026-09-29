/**
 * Capture → a weekly block, only on the person's confirm («ثابت أسبوعي»).
 *
 * «عندي تدريب كل سبت من الساعة 10 لـ 4» carries `recurrenceHint` since
 * FIX-R8 (PR #696). This lane turns a complete hint — the weekdays and a
 * settled start and end on the same day — into an offer on the item
 * (`weeklyBlock`, which the Review card renders «كل سبت · 10:00–16:00»), and a
 * confirm that *names* the item in `weeklyBlockItemIds` creates the weekly
 * block instead of a one-off commitment.
 *
 * Opt-in by name, deliberately: an older app shows the same item as a one-off
 * on Saturday, and its confirm must keep meaning exactly that. The person
 * confirmed what their screen showed them, so the server never upgrades a
 * confirm to a standing weekly claim on its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userCol, WEEKLY_BLOCKS } from '../../lib/storage/paths.ts';
import { clarifyMobileCapture, confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { listBusyBlocksOfSource } from '../../lib/calendar/busyBlocks.ts';
import { weeklyBusySourceId } from '../../lib/weeklyBlocks/weeklyBlockService.ts';
import type { WeeklyBlockDocument } from '../../src/contracts/v1/weeklyBlockContracts.ts';

const TZ = 'Asia/Jerusalem';
const TUE = new Date('2026-09-29T08:00:00.000Z');
const TRAINING = 'عندي تدريب كل سبت من الساعة 10 لـ 4';

type Item = {
  itemId: string;
  title: string;
  needsClarification: boolean;
  weeklyBlock?: { title: string; weekdays: number[]; start: string; end: string; timezone: string };
  clarification?: { questionId: string; questionKey: string; options: Array<{ optionId: string }> } | null;
};

let storage: MemoryStorageAdapter;
let counter = 0;
function fresh(): string {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  counter += 1;
  return `weekly-capture-${counter}`;
}
test.afterEach(() => resetStorageForTests());

async function propose(uid: string, text: string) {
  const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: TUE.toISOString() }, { participantId: uid });
  return { proposal, items: proposal.items as Item[] };
}

async function blocksOf(uid: string): Promise<WeeklyBlockDocument[]> {
  return (await storage.list<WeeklyBlockDocument>(userCol(uid, WEEKLY_BLOCKS))).map((row) => row.data);
}

test('a stated weekly range is offered as a weekly block, in all three languages', async () => {
  for (const [text, title] of [
    [TRAINING, 'عندي تدريب'],
    ['יש לי התמחות כל שבת מ-10 עד 4', 'יש לי התמחות'],
    ['internship every Saturday 10 to 4', 'internship'],
  ] as const) {
    const uid = fresh();
    const { items } = await propose(uid, text);
    assert.equal(items.length, 1, text);
    assert.deepEqual(items[0]!.weeklyBlock, { title, weekdays: [6], start: '10:00', end: '16:00', timezone: TZ }, text);
    // Offered is not saved.
    assert.deepEqual(await blocksOf(uid), [], text);
  }
});

test('no hint, no day, or no settled hour: no offer (the one-off and the clarify path stay)', async () => {
  const uid = fresh();
  assert.equal((await propose(uid, 'عندي تدريب بكرا من الساعة 10 لـ 4')).items[0]!.weeklyBlock, undefined);
  assert.equal((await propose(uid, 'عندي اجتماع كل أسبوع الساعة 10')).items[0]!.weeklyBlock, undefined);
  // A start and no end is no block either: nothing says when it stops.
  assert.equal((await propose(uid, 'عندي تدريب كل سبت الساعة 10')).items[0]!.weeklyBlock, undefined);
});

test('a bare 2 is asked صبح/مسا first; answered, the offer appears with the settled hours', async () => {
  const uid = fresh();
  const { proposal, items } = await propose(uid, 'عندي تدريب كل سبت من 2 لـ 4');
  assert.equal(items[0]!.clarification?.questionKey, 'ask_am_pm');
  assert.equal(items[0]!.weeklyBlock, undefined);
  const pm = items[0]!.clarification!.options.find((option) => option.optionId === 'pm')!;
  const answered = await clarifyMobileCapture({
    proposalId: proposal.proposalId, itemId: items[0]!.itemId, questionId: items[0]!.clarification!.questionId,
    optionId: pm.optionId, timezone: TZ, referenceTime: TUE.toISOString(),
  }, { participantId: uid });
  assert.deepEqual((answered.items as Item[])[0]!.weeklyBlock, { title: 'عندي تدريب', weekdays: [6], start: '14:00', end: '16:00', timezone: TZ });
});

test('confirmed as weekly: one block, its busy time, and no one-off commitment', async () => {
  const uid = fresh();
  const { proposal, items } = await propose(uid, TRAINING);
  const confirmed = await confirmMobileCapture({
    proposalId: proposal.proposalId, itemIds: [items[0]!.itemId], weeklyBlockItemIds: [items[0]!.itemId],
  }, { participantId: uid });
  assert.equal(confirmed.success, true);
  assert.deepEqual(confirmed.persisted, [], 'no commitment was written');
  assert.deepEqual(confirmed.failed, []);
  assert.deepEqual(Object.values((await getParticipantStateSnapshot(uid)).commitments), []);

  const [block] = await blocksOf(uid);
  assert.ok(block, 'no weekly block was stored');
  assert.deepEqual(
    [block.title, block.weekdays, block.start, block.end, block.timezone, block.status, block.source],
    ['عندي تدريب', [6], '10:00', '16:00', TZ, 'active', 'capture'],
  );
  assert.ok(Number.isFinite(Date.parse(block.confirmedAt)));
  assert.deepEqual(confirmed.weeklyBlocks.map((entry) => [entry.itemId, entry.block.id]), [[items[0]!.itemId, block.id]]);
  assert.deepEqual(confirmed.weeklyBlocks[0]!.block.deviceEvent?.weekdays, [6]);

  const occurrences = await listBusyBlocksOfSource(uid, weeklyBusySourceId(block.id), { storage });
  assert.equal(occurrences.length, 8);
  for (const occurrence of occurrences) {
    const local = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(occurrence.startAt));
    assert.equal(local, 'Sat 10:00');
  }

  // The same confirm again is a replay: still one block.
  const again = await confirmMobileCapture({
    proposalId: proposal.proposalId, itemIds: [items[0]!.itemId], weeklyBlockItemIds: [items[0]!.itemId],
  }, { participantId: uid });
  assert.equal(again.replayed, true);
  assert.equal((await blocksOf(uid)).length, 1);
});

test('an older app\'s confirm (no weeklyBlockItemIds) is still the one-off it showed', async () => {
  const uid = fresh();
  const { proposal, items } = await propose(uid, TRAINING);
  const confirmed = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: [items[0]!.itemId] }, { participantId: uid });
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.persisted.length, 1);
  assert.deepEqual(confirmed.weeklyBlocks, []);
  assert.deepEqual(await blocksOf(uid), []);
});

test('naming an item that has no offer, or one not selected, fails the whole confirm and writes nothing', async () => {
  const uid = fresh();
  const { proposal, items } = await propose(uid, 'عندي تدريب بكرا من الساعة 10 لـ 4');
  const refused = await confirmMobileCapture({
    proposalId: proposal.proposalId, itemIds: [items[0]!.itemId], weeklyBlockItemIds: [items[0]!.itemId],
  }, { participantId: uid });
  assert.equal(refused.success, false);
  assert.equal(refused.failureCode, 'invalid_selection');
  assert.deepEqual(Object.values((await getParticipantStateSnapshot(uid)).commitments), []);

  const weekly = await propose(uid, TRAINING);
  const unselected = await confirmMobileCapture({
    proposalId: weekly.proposal.proposalId, itemIds: ['someone-else'], weeklyBlockItemIds: [weekly.items[0]!.itemId],
  }, { participantId: uid });
  assert.equal(unselected.success, false);
  assert.deepEqual(await blocksOf(uid), []);
});

test('a title edit renames the block; a time edit on a weekly item is refused', async () => {
  const uid = fresh();
  const { proposal, items } = await propose(uid, TRAINING);
  const itemId = items[0]!.itemId;
  const timed = await confirmMobileCapture({
    proposalId: proposal.proposalId, itemIds: [itemId], weeklyBlockItemIds: [itemId],
    edits: [{ itemId, resolvedTime: '2026-10-03T08:00:00.000Z' }],
  }, { participantId: uid });
  assert.equal(timed.success, false);
  assert.equal(timed.failureCode, 'invalid_edit');
  assert.deepEqual(await blocksOf(uid), []);

  const renamed = await confirmMobileCapture({
    proposalId: proposal.proposalId, itemIds: [itemId], weeklyBlockItemIds: [itemId],
    edits: [{ itemId, title: 'تدريب' }],
  }, { participantId: uid });
  assert.equal(renamed.success, true);
  assert.equal((await blocksOf(uid))[0]!.title, 'تدريب');
});
