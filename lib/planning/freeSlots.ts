import { randomUUID } from 'node:crypto';
import type { Commitment } from '../../src/domain/stateMachine';
import type { ClarificationContract, CaptureProposalContract } from '../../src/contracts/v1/captureContracts';
import type { GoalPlanSlot } from '../../src/contracts/v1/goalPlanContracts';
import type { UserRoutineProfile } from '../../src/contracts/v1/routineContracts';
import type { PlanningConfig, PlanningConstraints, PlanningItem, TimeInterval } from '../../src/contracts/v1/planningContracts';
import { instantFromLocal, localTimeSpecFor } from '../../src/extraction/timeLexicon';
import { addCivilDays, composeDailyPlanRequest } from '../services/dailyPlan/dailyPlanService';
import { fixedStartOf, isPlannable } from '../services/dailyPlan/buildDailyPlan';
import { fixedEndFor } from '../services/timeCollision';
import { readRoutineProfile } from '../services/mobile/routineProfileService';
import { loadDomainState } from '../services/mobile/participantState';
import { listWeeklyBlockOccurrences } from '../weeklyBlocks/weeklyBlockService';
import { GOOGLE_BUSY_SOURCE_ID } from '../integrations/google/googleConfig';
import { connectionIdFor } from '../integrations/providers/production/storedConnectionStore';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import type { IcsFeedDocument } from '../calendar/icsFeeds';
import {
  listBusyBlocks,
  listCalendarSources,
  type BusyBlock,
  type CalendarSource,
} from '../calendar/busyBlocks';
import {
  ICS_FEEDS,
  PROVIDER_CONNECTIONS,
  getStorage,
  userCol,
  userDoc,
  userSubDoc,
  type StorageAdapter,
  type StorageReader,
  type StorageTransaction,
} from '../storage';
import { schedulePlan } from './scheduler';
import { readRuntimeBoolean } from '../../src/contracts/v1/runtimeControls';

const SLOT_MINUTES = 15;
const CAPTURE_DURATION_MINUTES = 30;
const MIN_LEAD_MINUTES = 60;
const CAPTURE_SLOT_SEPARATION_MINUTES = 90;
const DAY_MS = 86_400_000;

export type FreeSlotWindowPolicy = 'goalPlan' | 'capture';
export type FreeSlotSource = 'commitments' | 'busyBlocks' | 'weeklyBlocks' | 'routineProfile';

export interface FreeSlotStep {
  stepId: string;
  title: string;
  durationMinutes: number;
  rhythm?: { timeOfDay?: 'morning' | 'afternoon' | 'evening' };
}

export interface DayContext {
  date: string;
  constraints: PlanningConstraints;
  config: PlanningConfig;
}

export interface FreeSlotCoverage {
  sourceId: string;
  kind: 'device' | 'google' | 'ics';
  windowStart: string | null;
  windowEnd: string | null;
}

export interface FreeSlotSchedule {
  commitments: readonly Commitment[];
  busyBlocks: readonly BusyBlock[];
  weeklyBlocks: readonly TimeInterval[];
  routineProfile: UserRoutineProfile | null;
  coverage: readonly FreeSlotCoverage[];
  complete: boolean;
}

/** Release-locked capability shared by capture suggestions and the busy read. */
export function resolveFreeSlots(env: Record<string, string | undefined> = process.env): boolean {
  const environment = (env.MAYBESITTER_ENV ?? 'local').trim().toLowerCase() || 'local';
  if (!['local', 'test', 'staging'].includes(environment)) return false;
  if (readRuntimeBoolean(env.MAYBESITTER_KILL_SWITCH_FREE_SLOTS, false)) return false;
  return readRuntimeBoolean(env.MAYBESITTER_FEATURE_FREE_SLOTS, false);
}

function readerAdapter(reader: StorageReader): StorageAdapter {
  const unavailable = async (): Promise<never> => { throw new Error('transaction reader is read-only'); };
  return {
    get: reader.get.bind(reader),
    list: reader.list.bind(reader),
    listGroup: reader.listGroup.bind(reader),
    set: unavailable,
    delete: unavailable,
    deleteTree: unavailable,
    runTransaction: async (fn) => fn(reader as StorageTransaction),
  };
}

/** The planner's existing per-day input, kept byte-for-byte in policy behavior. */
export async function dayContexts(
  reader: StorageReader,
  uid: string,
  anchor: { localDate: string; timezone: string },
  dates: string[],
  now: string,
): Promise<DayContext[]> {
  const storage = readerAdapter(reader);
  const user = await reader.get<Record<string, unknown>>(userDoc(uid));
  const contexts: DayContext[] = [];
  for (const date of Array.from(new Set(dates)).sort()) {
    const request = await composeDailyPlanRequest(
      { uid, date, timezone: anchor.timezone, now, userDocument: user, previousBlocks: null },
      { storage },
    );
    contexts.push({ date, constraints: request.constraints, config: request.config });
  }
  return contexts;
}

export function atLocal(date: string, hhmm: string, timezone: string): string | null {
  return instantFromLocal(date, hhmm, timezone)?.toISOString() ?? null;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Exact planner placement used by the `goalPlan` policy. */
export function exactSlot(
  context: DayContext,
  step: FreeSlotStep,
  start: string,
  timezone: string,
  occupied: TimeInterval[],
): GoalPlanSlot | null {
  const startsAt = atLocal(context.date, start, timezone);
  if (!startsAt) return null;
  const endsAt = new Date(Date.parse(startsAt) + step.durationMinutes * 60_000).toISOString();
  const item: PlanningItem = {
    itemId: `goal-plan:${step.stepId}`,
    title: step.title,
    effort: { kind: 'known', minutes: step.durationMinutes },
    earliestStartAt: startsAt,
    deadlineAt: endsAt,
    priority: 1_000_000,
    dependsOn: [],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
  };
  const plan = schedulePlan({
    ...context.constraints,
    fixedEvents: [
      ...context.constraints.fixedEvents,
      ...occupied.map((interval, index) => ({
        eventId: `goal-plan-held-${index}`,
        interval,
        sourceCommitmentId: null,
        blocking: true,
      })),
    ],
    items: [...context.constraints.items, item],
  }, context.config);
  const placed = plan.scheduled.find((entry) => entry.itemId === item.itemId);
  return placed && placed.interval.startsAt === startsAt && placed.interval.endsAt === endsAt
    ? { startsAt, endsAt }
    : null;
}

export function candidateMinutes(step: FreeSlotStep, now: string, date: string, timezone: string): number[] {
  const range = step.rhythm?.timeOfDay === 'morning' ? [6 * 60, 12 * 60]
    : step.rhythm?.timeOfDay === 'afternoon' ? [12 * 60, 17 * 60]
      : step.rhythm?.timeOfDay === 'evening' ? [17 * 60, 22 * 60]
        : [6 * 60, 22 * 60];
  const result: number[] = [];
  for (let minute = range[0]; minute + step.durationMinutes <= range[1]; minute += SLOT_MINUTES) {
    const instant = atLocal(date, hhmm(minute), timezone);
    if (instant && Date.parse(instant) > Date.parse(now) + MIN_LEAD_MINUTES * 60_000) result.push(minute);
  }
  return result;
}

export function commitmentCandidates(
  step: FreeSlotStep,
  contexts: DayContext[],
  anchor: { timezone: string },
  now: string,
  occupied: TimeInterval[],
): GoalPlanSlot[] {
  const found: GoalPlanSlot[] = [];
  for (const context of contexts) {
    for (const minute of candidateMinutes(step, now, context.date, anchor.timezone)) {
      const slot = exactSlot(context, step, hhmm(minute), anchor.timezone, occupied);
      if (slot) found.push(slot);
      if (found.length === 4) return found;
    }
  }
  return found;
}

let sourceFailure: FreeSlotSource | null = null;
type ScheduleReader = (uid: string, window: TimeInterval, storage?: StorageAdapter) => Promise<FreeSlotSchedule>;
let scheduleReader: ScheduleReader = defaultScheduleReader;

export function setFreeSlotScheduleReaderForTests(
  wrap: ((original: ScheduleReader) => ScheduleReader) | null,
): void {
  scheduleReader = wrap ? wrap(defaultScheduleReader) : defaultScheduleReader;
}

export function setFreeSlotSourceFailureForTests(source: FreeSlotSource | null): void {
  sourceFailure = source;
}

async function sourceRead<T>(source: FreeSlotSource, read: () => Promise<T>): Promise<T> {
  if (sourceFailure === source) throw new Error(`injected ${source} failure`);
  return read();
}

function liveGoogle(record: IntegrationConnectionRecord | null): boolean {
  return Boolean(record
    && record.identity.provider === 'google'
    && record.state !== 'revoked'
    && record.state !== 'not_connected'
    && record.credentialRef
    && record.capabilities.includes('calendar_busy'));
}

async function defaultScheduleReader(
  uid: string,
  window: TimeInterval,
  storage: StorageAdapter = getStorage(),
): Promise<FreeSlotSchedule> {
  try {
    const [commitments, busyBlocks, weeklyBlocks, routineProfile, sources, feeds, google] = await Promise.all([
      sourceRead('commitments', async () => Object.values((await loadDomainState(storage, uid)).commitments)),
      sourceRead('busyBlocks', () => listBusyBlocks(uid, window, { storage })),
      sourceRead('weeklyBlocks', () => listWeeklyBlockOccurrences(uid, window, { storage })),
      sourceRead('routineProfile', () => readRoutineProfile(uid, { storage })),
      listCalendarSources(uid, { storage }),
      storage.list<IcsFeedDocument>(userCol(uid, ICS_FEEDS), { limit: 5 }),
      storage.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
    ]);
    const sourceById = new Map(sources.map((source) => [source.sourceId, source] as const));
    const coverage: FreeSlotCoverage[] = sources
      .filter((source) => source.kind === 'device')
      .map((source) => ({ sourceId: source.sourceId, kind: 'device', windowStart: source.windowStart, windowEnd: source.windowEnd }));
    if (liveGoogle(google)) {
      const source = sourceById.get(GOOGLE_BUSY_SOURCE_ID);
      coverage.push({ sourceId: GOOGLE_BUSY_SOURCE_ID, kind: 'google', windowStart: source?.windowStart ?? null, windowEnd: source?.windowEnd ?? null });
    }
    for (const { data: feed } of feeds) {
      const sourceId = `ics:${feed.feedId}`;
      const source = sourceById.get(sourceId);
      coverage.push({ sourceId, kind: 'ics', windowStart: source?.windowStart ?? null, windowEnd: source?.windowEnd ?? null });
    }
    const connectedIcs = new Set(feeds.map(({ data }) => `ics:${data.feedId}`));
    return {
      commitments,
      busyBlocks: busyBlocks.filter((block) => block.sourceKind !== 'weekly'
        && (block.sourceKind !== 'ics' || connectedIcs.has(block.sourceId))),
      weeklyBlocks: weeklyBlocks.map((row) => ({ startsAt: row.startAt, endsAt: row.endAt })),
      routineProfile,
      coverage,
      complete: true,
    };
  } catch {
    return { commitments: [], busyBlocks: [], weeklyBlocks: [], routineProfile: null, coverage: [], complete: false };
  }
}

export async function readFreeSlotSchedule(
  uid: string,
  window: TimeInterval,
  storage: StorageAdapter = getStorage(),
): Promise<FreeSlotSchedule> {
  return scheduleReader(uid, window, storage);
}

function overlaps(left: TimeInterval, right: TimeInterval): boolean {
  return Date.parse(left.startsAt) < Date.parse(right.endsAt) && Date.parse(right.startsAt) < Date.parse(left.endsAt);
}

function covered(interval: TimeInterval, sources: readonly FreeSlotCoverage[]): boolean {
  return sources.every((source) => source.windowStart !== null && source.windowEnd !== null
    && Date.parse(source.windowStart) <= Date.parse(interval.startsAt)
    && Date.parse(source.windowEnd) >= Date.parse(interval.endsAt));
}

function minutesOf(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function captureRanges(profile: UserRoutineProfile | null): Array<[number, number]> {
  if (!profile?.sleepWindow) return [[8 * 60, 22 * 60]];
  const start = minutesOf(profile.sleepWindow.start);
  const end = minutesOf(profile.sleepWindow.end);
  if (start < end) return [[0, start], [end, 24 * 60]];
  return [[end, start]];
}

function occupiedIntervals(schedule: FreeSlotSchedule): TimeInterval[] {
  const commitments = schedule.commitments.flatMap((commitment) => {
    if (!isPlannable(commitment) || commitment.timeSpec.allDay) return [];
    const start = fixedStartOf(commitment);
    return start ? [{ startsAt: start, endsAt: fixedEndFor(commitment, start) }] : [];
  });
  return [
    ...commitments,
    ...schedule.busyBlocks.filter((block) => !block.allDay).map((block) => ({ startsAt: block.startAt, endsAt: block.endAt })),
    ...schedule.weeklyBlocks,
  ];
}

export interface FindFreeSlotsInput {
  policy: FreeSlotWindowPolicy;
  uid: string;
  timezone: string;
  now: string;
  dates: readonly string[];
  durationMinutes: number;
  schedule?: FreeSlotSchedule;
  held?: readonly TimeInterval[];
  limit?: number;
  minimumSeparationMinutes?: number;
  storage?: StorageAdapter;
}

/** Finds free clock intervals under one of the two explicit policies. */
export async function findFreeSlots(input: FindFreeSlotsInput): Promise<GoalPlanSlot[]> {
  if (input.dates.length === 0) return [];
  if (input.policy === 'goalPlan') {
    const step: FreeSlotStep = { stepId: 'free-slot', title: 'free slot', durationMinutes: input.durationMinutes };
    const contexts = await dayContexts(input.storage ?? getStorage(), input.uid,
      { localDate: input.dates[0]!, timezone: input.timezone }, [...input.dates], input.now);
    return commitmentCandidates(step, contexts, { timezone: input.timezone }, input.now, [...(input.held ?? [])]);
  }
  const first = atLocal(input.dates[0]!, '00:00', input.timezone);
  const last = atLocal(addCivilDays(input.dates[input.dates.length - 1]!, 1), '00:00', input.timezone);
  if (!first || !last) return [];
  const schedule = input.schedule ?? await readFreeSlotSchedule(input.uid, { startsAt: first, endsAt: last }, input.storage);
  if (!schedule.complete) return [];
  const occupied = [...occupiedIntervals(schedule), ...(input.held ?? [])];
  const found: GoalPlanSlot[] = [];
  const limit = input.limit ?? 3;
  const separation = (input.minimumSeparationMinutes ?? CAPTURE_SLOT_SEPARATION_MINUTES) * 60_000;
  for (const date of [...input.dates].sort()) {
    for (const [rangeStart, rangeEnd] of captureRanges(schedule.routineProfile)) {
      for (let minute = rangeStart; minute + input.durationMinutes <= rangeEnd; minute += SLOT_MINUTES) {
        const startsAt = atLocal(date, hhmm(minute), input.timezone);
        if (!startsAt || Date.parse(startsAt) < Date.parse(input.now) + MIN_LEAD_MINUTES * 60_000) continue;
        const interval = { startsAt, endsAt: new Date(Date.parse(startsAt) + input.durationMinutes * 60_000).toISOString() };
        if (!covered(interval, schedule.coverage) || occupied.some((held) => overlaps(interval, held))) continue;
        if (found.some((slot) => Math.abs(Date.parse(slot.startsAt) - Date.parse(startsAt)) < separation)) continue;
        found.push(interval);
        if (found.length >= limit) return found;
      }
    }
  }
  return found;
}

function baseDayPartClarification(item: CaptureProposalContract['items'][number], now: string, timezone: string): ClarificationContract {
  const date = item.resolvedDate ?? localTimeSpecFor(new Date(Date.parse(now) + DAY_MS), timezone)?.date;
  const options: ClarificationContract['options'] = [
    ['morning', '09:00'],
    ['afternoon', '14:00'],
    ['evening', '19:00'],
  ].flatMap(([optionId, localTime]) => date && Date.parse(atLocal(date, localTime, timezone) ?? '') > Date.parse(now)
    ? [{ optionId, labelKey: optionId, labelParams: {}, value: { localDate: date, localTime } }]
    : []);
  options.push({ optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} });
  return {
    questionId: randomUUID(),
    field: 'time',
    questionKey: 'ask_time',
    params: item.resolvedDate ? { title: item.title, date: item.resolvedDate } : { title: item.title },
    options,
    allowFreeText: true,
  };
}

function isEligible(item: CaptureProposalContract['items'][number]): boolean {
  return item.resolvedTime === null && item.needsClarification === true
    && (item.clarification == null || (item.clarification.field === 'time' && item.clarification.questionKey === 'ask_time'));
}

/** Enriches every eligible item with free choices from one complete schedule snapshot. */
export async function withFreeSlotClarifications(
  contract: CaptureProposalContract,
  uid: string,
  options: { timezone: string; now: string; storage?: StorageAdapter },
): Promise<CaptureProposalContract> {
  if (!resolveFreeSlots() || !contract.items.some(isEligible)) return contract;
  const today = localTimeSpecFor(new Date(options.now), options.timezone)?.date;
  if (!today) return contract;
  const datesByItem = contract.items.map((item) => item.resolvedDate
    ? [item.resolvedDate]
    : Array.from({ length: 7 }, (_, index) => addCivilDays(today, index)));
  const allDates = Array.from(new Set(datesByItem.flat())).sort();
  const windowStart = atLocal(allDates[0]!, '00:00', options.timezone);
  const windowEnd = atLocal(addCivilDays(allDates[allDates.length - 1]!, 1), '00:00', options.timezone);
  if (!windowStart || !windowEnd) return contract;
  const schedule = await readFreeSlotSchedule(uid, { startsAt: windowStart, endsAt: windowEnd }, options.storage);
  const held: TimeInterval[] = contract.items.flatMap((item) => item.resolvedTime
    ? [{ startsAt: item.resolvedTime, endsAt: item.endTime && Date.parse(item.endTime) > Date.parse(item.resolvedTime)
      ? item.endTime : new Date(Date.parse(item.resolvedTime) + CAPTURE_DURATION_MINUTES * 60_000).toISOString() }]
    : []);
  const items = [] as CaptureProposalContract['items'];
  for (let index = 0; index < contract.items.length; index += 1) {
    const item = contract.items[index]!;
    if (!isEligible(item)) { items.push(item); continue; }
    const base = item.clarification ?? baseDayPartClarification(item, options.now, options.timezone);
    if (!schedule.complete) { items.push({ ...item, clarification: base }); continue; }
    const slots = await findFreeSlots({
      policy: 'capture', uid, timezone: options.timezone, now: options.now,
      dates: datesByItem[index]!, durationMinutes: CAPTURE_DURATION_MINUTES,
      schedule, held, limit: 3, minimumSeparationMinutes: CAPTURE_SLOT_SEPARATION_MINUTES,
      storage: options.storage,
    });
    if (slots.length === 0) { items.push({ ...item, clarification: base }); continue; }
    held.push(slots[0]!);
    const none = base.options.find((option) => option.optionId === 'none')
      ?? { optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} };
    items.push({
      ...item,
      clarification: {
        ...base,
        options: [
          ...slots.map((slot, slotIndex) => {
            const local = localTimeSpecFor(new Date(slot.startsAt), options.timezone)!;
            return {
              optionId: `slot-${slotIndex + 1}`,
              labelKey: 'freeSlot',
              labelParams: { localDate: local.date, localTime: local.time! },
              value: { localDate: local.date, localTime: local.time! },
            };
          }),
          none,
        ],
        allowFreeText: true,
      },
    });
  }
  return { ...contract, items };
}

export async function freeSlotStillAvailable(
  uid: string,
  date: string,
  time: string,
  options: { timezone: string; now: string; storage?: StorageAdapter },
): Promise<boolean> {
  const slots = await findFreeSlots({
    policy: 'capture', uid, timezone: options.timezone, now: options.now,
    dates: [date], durationMinutes: CAPTURE_DURATION_MINUTES,
    limit: 96, minimumSeparationMinutes: 0, storage: options.storage,
  });
  return slots.some((slot) => {
    const local = localTimeSpecFor(new Date(slot.startsAt), options.timezone);
    return local?.date === date && local.time === time;
  });
}
