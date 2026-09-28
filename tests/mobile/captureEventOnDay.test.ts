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
  const { answered, commitment } = await withMemoryStorage(() => answeredMorningThenNoTime('سجّل موعد أسنان يوم الجمعة', 'n11-dentist'));
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
