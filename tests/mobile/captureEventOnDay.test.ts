/**
 * The review card needs to know what "no time" will do to an item (UAT round
 * 3, N11).
 *
 * «سجّل موعد أسنان يوم الجمعة» → «الصبح» → Review «غيّر» → «بدون وقت» →
 * «خُد هيك»: the card and the Saved screen read only «بدون وقت», while the
 * confirm kept Friday (FY1 M1, `keepEventOnItsDay`: an event cleared of its
 * hour stays on its day). A task cleared of its hour loses the day, so the
 * card cannot just show `resolvedDate` for everything: it needs the server's
 * own answer, `eventOnDay`, on the proposal item. These tests hold the flag to
 * what the confirm actually does, for the event and for the task.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clarifyMobileCapture, confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter, StorageTransaction } from '../../lib/storage/storageAdapter.ts';
import { CAPTURE_PROPOSALS, userDoc } from '../../lib/storage/paths.ts';
import { getStorage } from '../../lib/storage/index.ts';
import { composeWeek, weekToDto } from '../../lib/services/dailyPlan/weekPlan.ts';

const TZ = 'Asia/Jerusalem';
/** Monday 28 September 2026, 03:37 in Jerusalem: when the round-3 UAT ran it. */
const NOW = new Date('2026-09-28T00:37:00.000Z');
const FRIDAY = '2026-10-02';

async function withMemoryStorage<T>(run: () => Promise<T>): Promise<T> {
  setStorageForTests(createMemoryStorage());
  try {
    return await run();
  } finally {
    resetStorageForTests();
  }
}

type ProposedItem = { itemId: string; resolvedTime: string | null; resolvedDate?: string; needsClarification: boolean; eventOnDay?: boolean };

/** Capture, answer «الصبح», then confirm with the edit sheet's «بدون وقت». */
async function answeredMorningThenNoTime(text: string, uid: string) {
  const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() }, { participantId: uid });
  const item = proposal.items[0]!;
  assert.equal(item.resolvedDate, FRIDAY, text);
  const morning = item.clarification?.options.find((option) => option.value.localTime === '09:00');
  assert.ok(morning, `${text}: no morning option in ${JSON.stringify(item.clarification)}`);
  const updated = await clarifyMobileCapture({
    proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: morning.optionId,
    timezone: TZ, referenceTime: NOW.toISOString(),
  }, { participantId: uid });
  const answered = updated.items.find((candidate) => candidate.itemId === item.itemId) as ProposedItem;
  assert.ok(answered.resolvedTime, `${text}: the morning answer set no time`);
  const confirmed = await confirmMobileCapture({
    proposalId: proposal.proposalId, itemIds: [item.itemId], edits: [{ itemId: item.itemId, resolvedTime: null }],
  }, { participantId: uid });
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
  const commitment = Object.values((await getParticipantStateSnapshot(uid)).commitments)[0]!;
  return { proposed: item as ProposedItem, answered, commitment };
}

test('N11: the dentist, answered «الصبح», says it stays on Friday without a time — and the confirm keeps Friday', async () => {
  const { proposed, answered, commitment } = await withMemoryStorage(() => answeredMorningThenNoTime('سجّل موعد أسنان يوم الجمعة', 'n11-dentist'));
  // Still asking for its hour: not confirmable, so nothing is promised yet
  // (review M2). An edit-sheet save would otherwise read «الجمعة · بدون وقت»
  // on an item the confirm keeps nothing of.
  assert.equal(proposed.needsClarification, true);
  assert.equal(proposed.eventOnDay, undefined);
  assert.equal(answered.eventOnDay, true);
  assert.equal(answered.resolvedDate, FRIDAY);
  // What the flag promises is what the confirm did.
  assert.equal(commitment.timeSpec.kind, 'scheduled_event');
  assert.equal(commitment.timeSpec.allDay, true);
  // On Friday in the commitment's own zone. (Which zone that is on this path
  // is `keepEventOnItsDay`'s business, not this flag's; see the FZ2 report.)
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: commitment.timeSpec.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(commitment.timeSpec.dueAt!));
  assert.equal(day, FRIDAY);
});

test('N11: a task on Friday carries no such flag — cleared of its hour, it loses the day', async () => {
  const { proposed, answered, commitment } = await withMemoryStorage(() => answeredMorningThenNoTime('بدي أتصل بسامي يوم الجمعة', 'n11-task'));
  assert.equal(proposed.eventOnDay, undefined);
  assert.equal(answered.eventOnDay, undefined);
  assert.deepEqual({ kind: commitment.timeSpec.kind, dueAt: commitment.timeSpec.dueAt }, { kind: 'unscheduled', dueAt: null });
});

test('N11: an appointment with its hour already said is flagged on the first proposal', async () => {
  await withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture(
      { text: 'موعد دكتور يوم الجمعة الساعة 10 الصبح', timezone: TZ, referenceTime: NOW.toISOString() },
      { participantId: 'n11-timed' },
    );
    const item = proposal.items[0] as ProposedItem;
    assert.equal(item.needsClarification, false);
    assert.equal(item.resolvedDate, FRIDAY);
    assert.equal(item.eventOnDay, true);
  });
});

/**
 * Storage whose proposal reads fail once a proposal has been written while
 * `armed` — the flag's own read, after the answer or the proposal is saved.
 */
function failingFlagRead(): { storage: StorageAdapter; arm(): void; failed(): number } {
  const inner = createMemoryStorage();
  let armed = false;
  let written = false;
  let failures = 0;
  const storage = new Proxy(inner, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (key === 'set') {
        return async (path: string, data: unknown) => {
          if (armed && path.includes(`/${CAPTURE_PROPOSALS}/`)) written = true;
          return (value as (p: string, d: unknown) => Promise<void>).call(target, path, data);
        };
      }
      if (key === 'runTransaction') {
        return async <R>(fn: (tx: StorageTransaction) => Promise<R>) => (
          value as (callback: (tx: StorageTransaction) => Promise<R>) => Promise<R>
        ).call(target, (tx) => fn(new Proxy(tx, {
          get(transaction, transactionKey, transactionReceiver) {
            const operation = Reflect.get(transaction, transactionKey, transactionReceiver) as unknown;
            if (typeof operation !== 'function') return operation;
            if (transactionKey === 'set') {
              return (path: string, data: unknown) => {
                if (armed && path.includes(`/${CAPTURE_PROPOSALS}/`)) written = true;
                return (operation as (p: string, d: unknown) => void).call(transaction, path, data);
              };
            }
            return (operation as (...args: unknown[]) => unknown).bind(transaction);
          },
        })));
      }
      if (key === 'listGroup') {
        return async (collection: string, options: unknown) => {
          if (armed && written && collection === CAPTURE_PROPOSALS) {
            failures += 1;
            throw new Error('UNAVAILABLE: transient read');
          }
          return (value as (c: string, o: unknown) => Promise<unknown>).call(target, collection, options);
        };
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  }) as StorageAdapter;
  return { storage, arm: () => { armed = true; }, failed: () => failures };
}

test('N11 review M3: a failed flag read after a saved clarify answer returns the answer, unflagged, not an error', async () => {
  const { storage, arm, failed } = failingFlagRead();
  setStorageForTests(storage);
  try {
    const uid = 'n11-flaky';
    const proposal = await proposeMobileCapture({ text: 'سجّل موعد أسنان يوم الجمعة', timezone: TZ, referenceTime: NOW.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    const morning = item.clarification!.options.find((option) => option.value.localTime === '09:00')!;
    arm();
    const updated = await clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: morning.optionId,
      timezone: TZ, referenceTime: NOW.toISOString(),
    }, { participantId: uid });
    assert.equal(failed(), 1, 'the flag read was never made to fail, so this proves nothing');
    const answered = updated.items[0] as ProposedItem;
    assert.ok(answered.resolvedTime, 'the saved answer did not come back');
    assert.equal(answered.eventOnDay, undefined);
  } finally {
    resetStorageForTests();
  }
});

test('N11 review M3: a failed flag read after a stored proposal returns the proposal, unflagged, not an error', async () => {
  const { storage, arm, failed } = failingFlagRead();
  setStorageForTests(storage);
  try {
    arm();
    const proposal = await proposeMobileCapture(
      { text: 'موعد دكتور يوم الجمعة الساعة 10 الصبح', timezone: TZ, referenceTime: NOW.toISOString() },
      { participantId: 'n11-flaky-propose' },
    );
    assert.equal(failed(), 1, 'the flag read was never made to fail, so this proves nothing');
    const item = proposal.items[0] as ProposedItem;
    assert.equal(item.resolvedDate, FRIDAY);
    assert.equal(item.eventOnDay, undefined);
  } finally {
    resetStorageForTests();
  }
});

/*
 * Integration (FZ1 × FZ2, closure): the whole round-3 path, into the week.
 * «سجّل موعد أسنان يوم الجمعة» → «الصبح» → Review «بدون وقت» → confirm →
 * «خطّط أسبوعي». FZ1 carries the person's zone on a clarified answer, so the
 * cleared appointment is stored at *local* midnight in that zone (it was UTC
 * midnight in zone 'UTC'); FZ2 flags it eventOnDay on the card and shows it in
 * the week as an all-day row on its day (N13). The week reads an all-day day
 * in the commitment's own zone, so the row would sit on Friday either way; the
 * stored instant is what the phone draws in the account's zone, and west of
 * UTC the old UTC midnight read as Thursday evening. Both are held here, in
 * the UAT zone and in one west of UTC.
 */
for (const [zone, now] of [
  ['Asia/Jerusalem', new Date('2026-09-28T07:00:00.000Z')], // Mon 10:00 local (UTC+3)
  ['America/New_York', new Date('2026-09-28T14:00:00.000Z')], // Mon 10:00 local (UTC-4)
] as const) {
  test(`integration (FZ1 × FZ2): a clarified appointment cleared to «بدون وقت» is an all-day week row on its local Friday (${zone})`, async () => {
    const uid = `fz-int-${zone.replace('/', '-')}`;
    await withMemoryStorage(async () => {
      const storage = getStorage();
      await storage.set(userDoc(uid), { uid, timezone: zone, locale: 'ar' });
      const proposal = await proposeMobileCapture({ text: 'سجّل موعد أسنان يوم الجمعة', timezone: zone, referenceTime: now.toISOString() }, { participantId: uid });
      const item = proposal.items[0]!;
      assert.equal(item.clarification?.questionKey, 'ask_time');
      const answered = await clarifyMobileCapture({
        proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: 'morning',
        timezone: zone, referenceTime: now.toISOString(),
      }, { participantId: uid });
      // FZ2's card: its day is kept.
      assert.deepEqual([answered.items[0]!.resolvedDate, (answered.items[0] as ProposedItem).eventOnDay], [FRIDAY, true]);
      const confirmed = await confirmMobileCapture({
        proposalId: proposal.proposalId, itemIds: [item.itemId], edits: [{ itemId: item.itemId, resolvedTime: null }],
      }, { participantId: uid });
      assert.equal(confirmed.success, true, JSON.stringify(confirmed));
      const commitment = Object.values((await getParticipantStateSnapshot(uid)).commitments)[0]!;
      // FZ1: stored in the person's zone, at that zone's midnight — the day the
      // phone draws in the account's zone.
      assert.equal(commitment.timeSpec.timezone, zone);
      const localDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
      assert.equal(localDay(commitment.timeSpec.dueAt!), FRIDAY);
      // FZ2 N13: the week shows it as an all-day row on Friday, and nowhere else.
      const dto = weekToDto(await composeWeek(uid, { moves: [], drops: [] }, { storage, now: () => now }));
      const allDayOn = Object.fromEntries(dto.days.map((day) => [day.date, day.allDay.map((row) => row.itemId)]));
      assert.deepEqual(
        Object.entries(allDayOn).filter(([, ids]) => ids.length > 0),
        [[FRIDAY, [commitment.id]]],
      );
      const rows = dto.days.flatMap((day) => [...day.items, ...day.fixed, ...day.unplaced].map((row) => row.itemId));
      assert.ok(!rows.includes(commitment.id), JSON.stringify(dto.days));
    });
  });
}
