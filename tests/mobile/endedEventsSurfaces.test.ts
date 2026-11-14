/**
 * An appointment that is over leaves every active surface (owner decision
 * 2026-11-12, spec Part 1, lane E1).
 *
 * ── The defect ───────────────────────────────────────────────────
 *
 * #383 rolls unfinished work into Today until the person acts on it. That is
 * right for a task and was never meant for a meeting: the lists never read
 * when an event *ends*, so a lecture three weeks ago that nobody marked done
 * was still on Today, ranked as an "overdue" next step, and floated into this
 * morning's plan as a thirty-minute task.
 *
 * ── The scenario, fixed in time ──────────────────────────────────
 *
 * The clock is 2026-11-12 15:00 in Jerusalem (13:00Z), the dates of the
 * root-cause scratch test. The account holds:
 *
 *   lecture   — 2026-10-22 10:00–12:00, three weeks ago, never marked done;
 *   doctor    — yesterday, all day, no hour;
 *   meeting   — this morning 09:00–10:00;
 *   overdue   — a *task* due yesterday 18:00: it still rolls into today (#383);
 *   evening   — a meeting later today, 18:00–19:00: it still shows.
 *
 * Every assertion is asked of the shipped service, never of a copy of its rule.
 * Ended events are not closed here (their status is untouched — E2 builds the
 * place they go next); they only stop being offered as live.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState, readParticipantState } from '../../lib/services/mobile/participantState.ts';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { listTodayRanked, listUpcomingRanked } from '../../lib/services/mobile/commitmentService.ts';
import { selectNextStepForArmFromState } from '../../lib/experiments/nextStepArms.ts';
import { buildDailyPlanInput } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { composeWeek, weekToDto } from '../../lib/services/dailyPlan/weekPlan.ts';
import { uidFor } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

const UID = uidFor('EndedEventsUser');
const TZ = 'Asia/Jerusalem';
/** Thursday 2026-11-12, 15:00 in Jerusalem (UTC+2 in November). */
const NOW = new Date('2026-11-12T13:00:00.000Z');
const TODAY = '2026-11-12';

const ENDED = ['lecture', 'doctor', 'meeting'] as const;

function commitment(
  id: string,
  timeSpec: Partial<Commitment['timeSpec']> & Pick<Commitment['timeSpec'], 'kind' | 'dueAt'>,
  priority: Commitment['priority'] = { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: 'active',
    priority,
    category: null,
    categorySource: 'inferred',
    timeSpec: { endAt: null, remindAt: null, allDay: false, timezone: TZ, ...timeSpec },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    confirmedAt: '2026-10-01T08:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  } as Commitment;
}

/** The lecture is the one the person said mattered most, so the old ranking put it first. */
const MUST = { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } as const;

function scenario(): Commitment[] {
  return [
    commitment('lecture', { kind: 'scheduled_event', dueAt: '2026-10-22T08:00:00.000Z', endAt: '2026-10-22T10:00:00.000Z' }, MUST),
    // Yesterday's local midnight in Jerusalem: an all-day appointment names a day.
    commitment('doctor', { kind: 'scheduled_event', dueAt: '2026-11-10T22:00:00.000Z', allDay: true }),
    commitment('meeting', { kind: 'scheduled_event', dueAt: '2026-11-12T07:00:00.000Z', endAt: '2026-11-12T08:00:00.000Z' }),
    commitment('overdue', { kind: 'due_by', dueAt: '2026-11-11T16:00:00.000Z' }),
    commitment('evening', { kind: 'scheduled_event', dueAt: '2026-11-12T16:00:00.000Z', endAt: '2026-11-12T17:00:00.000Z' }),
  ];
}

function stateOf(items: readonly Commitment[]): DomainState {
  const state = createEmptyDomainState();
  for (const item of items) state.commitments[item.id] = item;
  return state;
}

async function seed(storage: StorageAdapter): Promise<void> {
  setStorageForTests(storage);
  await seedLiveAccount(UID, storage);
  const user = await storage.get<Record<string, unknown>>(userDoc(UID));
  await storage.set(userDoc(UID), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await persistParticipantState(UID, stateOf(scenario()));
}

async function withSeeded(body: (storage: StorageAdapter) => Promise<void>): Promise<void> {
  const storage = createMemoryStorage();
  try {
    await seed(storage);
    await body(storage);
  } finally {
    resetStorageForTests();
  }
}

/** Membership is not the ranking module's to decide (#384), so both settings are asked. */
async function underBothRuntimes(body: () => Promise<void>): Promise<void> {
  const previous = process.env.MAYBESITTER_FEATURE_PRIORITY;
  try {
    for (const flag of ['false', 'true']) {
      process.env.MAYBESITTER_FEATURE_PRIORITY = flag;
      await body();
    }
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_FEATURE_PRIORITY;
    else process.env.MAYBESITTER_FEATURE_PRIORITY = previous;
  }
}

/* ── Lists ───────────────────────────────────────────────────────── */

test('E1 lists: ended events leave Today, the overdue task and the evening meeting stay', async () => {
  await withSeeded(async () => {
    await underBothRuntimes(async () => {
      const today = (await listTodayRanked({ participantId: UID, timezone: TZ, now: NOW })).items.map((c) => c.id).sort();
      assert.deepEqual(today, ['evening', 'overdue']);
    });
  });
});

test('E1 lists: ended events are on Upcoming neither', async () => {
  await withSeeded(async () => {
    await underBothRuntimes(async () => {
      const upcoming = (await listUpcomingRanked({ participantId: UID, timezone: TZ, now: NOW })).items.map((c) => c.id);
      for (const id of ENDED) assert.equal(upcoming.includes(id), false, `${id} reached Upcoming`);
    });
  });
});

test('E1 lists: leaving the lists closes nothing — status is untouched and the account still holds them', async () => {
  await withSeeded(async () => {
    const ranked = await listTodayRanked({ participantId: UID, timezone: TZ, now: NOW });
    const state = await readParticipantState(UID);
    for (const id of ENDED) {
      assert.equal(state.commitments[id]?.status, 'active', `${id} was closed; E1 must not change status`);
      assert.equal(ranked.calendarEligibleIds.has(id), true, `${id} lost its calendar entry`);
    }
  });
});

test('E1 lists: an event still running is on Today until its end', async () => {
  const storage = createMemoryStorage();
  try {
    await seed(storage);
    // 09:30 local: the meeting is under way.
    const during = new Date('2026-11-12T07:30:00.000Z');
    const ids = (await listTodayRanked({ participantId: UID, timezone: TZ, now: during })).items.map((c) => c.id);
    assert.equal(ids.includes('meeting'), true, 'a meeting in progress left Today');
  } finally {
    resetStorageForTests();
  }
});

test('E1 lists: a meeting the person marked done is still on today\'s Finished, like any settled item', async () => {
  const storage = createMemoryStorage();
  try {
    await seed(storage);
    const done = { ...scenario().find((c) => c.id === 'meeting')!, status: 'completed' as const, completedAt: '2026-11-12T08:05:00.000Z' };
    await persistParticipantState(UID, stateOf([...scenario().filter((c) => c.id !== 'meeting'), done]));
    const ids = (await listTodayRanked({ participantId: UID, timezone: TZ, now: NOW })).items.map((c) => c.id);
    assert.equal(ids.includes('meeting'), true, 'a finished meeting vanished from today\'s Finished group');
  } finally {
    resetStorageForTests();
  }
});

/* ── Next step ───────────────────────────────────────────────────── */

test('E1 next step: an ended event is never the next step, and the overdue task still is', () => {
  const state = stateOf(scenario());
  const selection = selectNextStepForArmFromState('generic', state, {
    now: NOW,
    locale: 'en',
    proposalId: 'p-ended',
    timezone: TZ,
  });
  const scored = selection.scores.map((score) => score.commitmentId);
  for (const id of ENDED) assert.equal(scored.includes(id), false, `${id} is still a next-step candidate`);
  assert.equal(selection.selectedCommitmentId, 'overdue');
});

/* ── Daily plan ──────────────────────────────────────────────────── */

function planFor(date: string, builtAt: Date) {
  return buildDailyPlanInput({
    uid: UID,
    date,
    timezone: TZ,
    commitments: scenario(),
    busyBlocks: [],
    profile: null,
    focusHint: null,
    builtAt: builtAt.toISOString(),
  }).constraints;
}

test('E1 daily plan: ended events are neither floating work nor pinned rows today', () => {
  const constraints = planFor(TODAY, NOW);
  assert.deepEqual(constraints.items.map((item) => item.itemId), ['overdue'], 'yesterday\'s task rolls in; nothing else floats');
  const pinned = constraints.fixedEvents.flatMap((event) => (event.sourceCommitmentId ? [event.sourceCommitmentId] : []));
  assert.deepEqual(pinned, ['evening']);
});

test('E1 daily plan: tomorrow\'s plan built this afternoon does not float tonight\'s meeting into it', () => {
  const constraints = planFor('2026-11-13', NOW);
  assert.equal(constraints.items.some((item) => item.itemId === 'evening'), false, 'tonight\'s meeting became tomorrow\'s task');
});

/* ── Week plan ───────────────────────────────────────────────────── */

test('E1 week plan: ended events are on no day of the week, the overdue task is today\'s step', async () => {
  await withSeeded(async (storage) => {
    const dto = weekToDto(await composeWeek(UID, { moves: [], drops: [] }, { storage, now: () => NOW }));
    assert.equal(dto.today, TODAY);
    for (const day of dto.days) {
      const shown = [...day.items, ...day.fixed, ...day.unplaced].map((row) => row.itemId);
      for (const id of ENDED) assert.equal(shown.includes(id), false, `${id} is on ${day.date}`);
    }
    const today = dto.days.find((day) => day.date === TODAY)!;
    assert.deepEqual(today.items.map((item) => item.itemId), ['overdue']);
    assert.deepEqual(today.fixed.map((row) => row.itemId), ['evening']);
  });
});

/* ── A task given an hour is still a task ────────────────────────── */

test('E1: a task given an hour (a scheduled_event with no end, CL1) still rolls into Today and the plan (#383)', async () => {
  // «أشتري دوا الساعة 10» this morning: capture stores a clock time with no
  // limit word as a `scheduled_event`, but it is something to do, not an
  // appointment that happened.
  const medicine = { ...commitment('medicine', { kind: 'scheduled_event', dueAt: '2026-11-12T08:00:00.000Z' }), title: 'أشتري دوا' };
  const storage = createMemoryStorage();
  try {
    await seed(storage);
    await persistParticipantState(UID, stateOf([...scenario(), medicine]));
    const today = (await listTodayRanked({ participantId: UID, timezone: TZ, now: NOW })).items.map((c) => c.id).sort();
    assert.deepEqual(today, ['evening', 'medicine', 'overdue']);
  } finally {
    resetStorageForTests();
  }
  // The plan keeps it at the hour the person chose, as it always has: a fixed
  // row today. Tomorrow's plan rolls it forward as work (#383), unlike an
  // appointment.
  const plan = (date: string) => buildDailyPlanInput({
    uid: UID, date, timezone: TZ, commitments: [...scenario(), medicine],
    busyBlocks: [], profile: null, focusHint: null, builtAt: NOW.toISOString(),
  }).constraints;
  assert.ok(plan(TODAY).fixedEvents.some((event) => event.sourceCommitmentId === 'medicine'), 'the medicine left today\'s plan');
  assert.ok(plan('2026-11-13').items.some((item) => item.itemId === 'medicine'), 'an undone task did not roll into tomorrow');
});
