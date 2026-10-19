import { randomUUID } from 'node:crypto';
import type { Commitment } from '../../src/domain/stateMachine';
import type { ClarificationContract, CaptureProposalContract } from '../../src/contracts/v1/captureContracts';
import type { GoalPlanSlot } from '../../src/contracts/v1/goalPlanContracts';
import type { UserRoutineProfile } from '../../src/contracts/v1/routineContracts';
import type { PlanningConfig, PlanningConstraints, PlanningItem, TimeInterval } from '../../src/contracts/v1/planningContracts';
import { instantFromLocal, localTimeSpecFor } from '../../src/extraction/timeLexicon';
import { addCivilDays, composeDailyPlanRequest } from '../services/dailyPlan/dailyPlanService';
import { fixedStartOf, isPlannable } from '../services/dailyPlan/buildDailyPlan';
import { candidateIntervalOf, collisionIntervalOf, fixedEndFor, findCollisions, type CollisionCandidate } from '../services/timeCollision';
import type { CaptureItemConflictContract } from '../../src/contracts/v1/captureContracts';
import { readRoutineProfile } from '../services/mobile/routineProfileService';
import { loadDomainState } from '../services/mobile/participantState';
import { listWeeklyBlockScheduleOccurrences } from '../weeklyBlocks/weeklyBlockService';
import { GOOGLE_BUSY_SOURCE_ID } from '../integrations/google/googleConfig';
import { connectionIdFor } from '../integrations/providers/production/storedConnectionStore';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import type { IcsFeedDocument } from '../calendar/icsFeeds';
import { icsFeedReadStatus, type IcsFeedReadStatus } from '../calendar/icsFeedStatus';
import {
  readCalendarSource,
  readPlanningBusyState,
  type BusySourceReplacementFence,
  type BusyBlock,
} from '../calendar/busyBlocks';
import {
  BUSY_SOURCE_FENCES,
  ICS_FEEDS,
  PROVIDER_CONNECTIONS,
  getStorage,
  userCol,
  userDoc,
  userSubDoc,
  docIdForKey,
  type StorageAdapter,
  type StorageReader,
  type StorageTransaction,
} from '../storage';
import { schedulePlan } from './scheduler';
import { readRuntimeBoolean } from '../../src/contracts/v1/runtimeControls';
import { runMemoryConcurrentTransactionWindow } from '../storage/memoryAdapter';

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
  status?: IcsFeedReadStatus;
  lifecycle?: 'uploading' | 'active' | 'clearing' | 'retiring';
  coverageStatus?: 'settled' | 'refreshing' | 'clearing' | 'stale';
}

export interface FreeSlotSchedule {
  commitments: readonly Commitment[];
  busyBlocks: readonly BusyBlock[];
  weeklyBlocks: readonly (TimeInterval & { title: string })[];
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
type ScheduleReader = (uid: string, window: TimeInterval, storage?: StorageAdapter, now?: string) => Promise<FreeSlotSchedule>;
let scheduleReader: ScheduleReader = defaultScheduleReader;

export type ScheduleDecisionSite = 'football' | 'ics' | 'heldAdd' | 'postpone' | 'impact' | 'autoAdd';
let scheduleDecisionHook: ((site: ScheduleDecisionSite) => Promise<void>) | null = null;

/** Test-only race seam. It deliberately runs inside the caller's transaction. */
export function setScheduleDecisionHookForTests(hook: ((site: ScheduleDecisionSite) => Promise<void>) | null): void {
  scheduleDecisionHook = hook;
}

export async function runScheduleDecisionHook(site: ScheduleDecisionSite): Promise<void> {
  if (scheduleDecisionHook) await runMemoryConcurrentTransactionWindow(() => scheduleDecisionHook!(site));
}

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

function liveGoogle(record: IntegrationConnectionRecord | null): record is IntegrationConnectionRecord {
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
  now: string = new Date().toISOString(),
): Promise<FreeSlotSchedule> {
  try {
    const [commitments, planningBusy, weeklyBlocks, routineProfile, feeds, google, googleFence] = await Promise.all([
      sourceRead('commitments', async () => Object.values((await loadDomainState(storage, uid)).commitments)),
      sourceRead('busyBlocks', () => readPlanningBusyState(uid, window, { storage })),
      sourceRead('weeklyBlocks', () => listWeeklyBlockScheduleOccurrences(uid, window, { storage, now: new Date(now) })),
      sourceRead('routineProfile', () => readRoutineProfile(uid, { storage })),
      storage.list<IcsFeedDocument>(userCol(uid, ICS_FEEDS), { limit: 5 }),
      storage.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
      storage.get<BusySourceReplacementFence>(userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID))),
    ]);
    const [googleSource, ...icsSources] = await Promise.all([
      liveGoogle(google) ? readCalendarSource(uid, GOOGLE_BUSY_SOURCE_ID, { storage }) : Promise.resolve(null),
      ...feeds.map(({ data: feed }) => readCalendarSource(uid, `ics:${feed.feedId}`, { storage })),
    ]);
    const registrations = new Map(planningBusy.registrations.map((row) => [row.sourceId, row] as const));
    const deviceSources = planningBusy.sources.filter((source) => source.kind === 'device');
    const coverage: FreeSlotCoverage[] = deviceSources.map((source) => {
      const registration = registrations.get(source.sourceId);
      const generationMatches = planningBusy.choice === null || source.choiceGeneration === planningBusy.choice.generation;
      const lifecycle = planningBusy.choice === null
        ? source.status
        : registration?.state === 'retiring' ? 'retiring' as const
          : !generationMatches || source.status === undefined ? 'uploading' as const
            : source.status;
      return {
        sourceId: source.sourceId,
        kind: 'device' as const,
        windowStart: source.windowStart,
        windowEnd: source.windowEnd,
        lifecycle,
        coverageStatus: source.coverageStatus,
      };
    });
    if (planningBusy.choice?.state === 'purging') {
      coverage.push({ sourceId: 'device:purging', kind: 'device', windowStart: null, windowEnd: null, lifecycle: 'uploading' });
    }
    if (liveGoogle(google)) {
      const certificate = googleSource?.m5Certificate;
      const certificateValid = planningBusy.choice === null || Boolean(certificate
        && certificate.v === 1
        && certificate.choiceGeneration === planningBusy.choice.generation
        && certificate.providerAccountId === google.identity.providerAccountId
        && certificate.fenceGeneration === (googleFence?.generation ?? 0));
      coverage.push({
        sourceId: GOOGLE_BUSY_SOURCE_ID,
        kind: 'google',
        windowStart: googleSource?.windowStart ?? null,
        windowEnd: googleSource?.windowEnd ?? null,
        coverageStatus: certificateValid ? googleSource?.coverageStatus : 'stale',
      });
    }
    for (let index = 0; index < feeds.length; index += 1) {
      const feed = feeds[index]!.data;
      const sourceId = `ics:${feed.feedId}`;
      const source = icsSources[index] ?? null;
      coverage.push({
        sourceId,
        kind: 'ics',
        windowStart: source?.windowStart ?? null,
        windowEnd: source?.windowEnd ?? null,
        status: icsFeedReadStatus(feed, source, Date.parse(now)),
        coverageStatus: source?.coverageStatus,
      });
    }
    const connectedIcs = new Set(feeds.map(({ data }) => `ics:${data.feedId}`));
    return {
      commitments,
      busyBlocks: planningBusy.blocks.filter((block) => block.sourceKind !== 'weekly'
        && (block.sourceKind !== 'ics' || connectedIcs.has(block.sourceId))),
      weeklyBlocks: weeklyBlocks.map((row) => ({ startsAt: row.startAt, endsAt: row.endAt, title: row.title })),
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
  now?: string,
): Promise<FreeSlotSchedule> {
  return scheduleReader(uid, window, storage, now);
}

function overlaps(left: TimeInterval, right: TimeInterval): boolean {
  return Date.parse(left.startsAt) < Date.parse(right.endsAt) && Date.parse(right.startsAt) < Date.parse(left.endsAt);
}

export function intervalCovered(interval: TimeInterval, sources: readonly FreeSlotCoverage[]): boolean {
  return sources.every((source) => (source.kind !== 'ics' || source.status === 'ok')
    && source.lifecycle !== 'uploading' && source.lifecycle !== 'retiring'
    && source.coverageStatus !== 'refreshing' && source.coverageStatus !== 'clearing' && source.coverageStatus !== 'stale'
    && source.windowStart !== null && source.windowEnd !== null
    && Date.parse(source.windowStart) <= Date.parse(interval.startsAt)
    && Date.parse(source.windowEnd) > Date.parse(interval.endsAt));
}

export type Clash = Omit<CaptureItemConflictContract, 'inProposal'>;
export type CandidateClashResult =
  | { state: 'free' }
  | { state: 'clash'; clashes: Clash[] }
  | { state: 'unknown'; reason: 'incomplete' | 'uncovered' };

export interface CandidateClashOptions {
  excludeCommitmentIds?: readonly string[];
  overlay?: readonly ({ startsAt: string; endsAt: string; title?: string | null; kind?: Clash['kind']; removeCommitmentId?: string })[];
}

function asCollisionCandidate(candidate: CollisionCandidate | { timeSpec: Commitment['timeSpec'] }): CollisionCandidate | null {
  return 'timeSpec' in candidate ? collisionIntervalOf(candidate) : candidate;
}

/** One candidate-aware occupancy rule shared by external holds and postpone. */
export function candidateClashes(
  schedule: FreeSlotSchedule,
  candidate: CollisionCandidate | { timeSpec: Commitment['timeSpec'] },
  options: CandidateClashOptions = {},
): CandidateClashResult {
  const collisionCandidate = asCollisionCandidate(candidate);
  if (!collisionCandidate) return { state: 'free' };
  const interval = candidateIntervalOf(collisionCandidate);
  if (!schedule.complete) return { state: 'unknown', reason: 'incomplete' };
  if (!intervalCovered(interval, schedule.coverage)) return { state: 'unknown', reason: 'uncovered' };
  const excluded = new Set(options.excludeCommitmentIds ?? []);
  for (const row of options.overlay ?? []) if (row.removeCommitmentId) excluded.add(row.removeCommitmentId);
  const clashes: Clash[] = findCollisions(collisionCandidate, schedule.commitments.filter((row) => !excluded.has(row.id)))
    .map((row) => ({ title: row.title, startsAt: row.startsAt, endsAt: row.endsAt, kind: 'commitment' as const }));
  for (const block of schedule.weeklyBlocks) {
    if (overlaps(interval, block)) clashes.push({ title: block.title, startsAt: block.startsAt, endsAt: block.endsAt, kind: 'weekly' });
  }
  for (const block of schedule.busyBlocks) {
    if (!block.allDay && overlaps(interval, { startsAt: block.startAt, endsAt: block.endAt })) {
      clashes.push({ title: null, startsAt: block.startAt, endsAt: block.endAt, kind: 'calendar_busy' });
    }
  }
  for (const row of options.overlay ?? []) {
    if (overlaps(interval, row)) clashes.push({ title: row.title ?? null, startsAt: row.startsAt, endsAt: row.endsAt, kind: row.kind ?? 'fixture' });
  }
  clashes.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)
    || a.kind.localeCompare(b.kind) || (a.title ?? '').localeCompare(b.title ?? ''));
  const unique = clashes.filter((row, index) => index === clashes.findIndex((other) => JSON.stringify(other) === JSON.stringify(row))).slice(0, 3);
  return unique.length ? { state: 'clash', clashes: unique } : { state: 'free' };
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

/** Timed items in the proposal are held while its untimed siblings are checked. */
export function captureTimedIntervals(contract: CaptureProposalContract): TimeInterval[] {
  return contract.items.flatMap((item) => item.resolvedTime
    ? [{
      startsAt: item.resolvedTime,
      endsAt: item.endTime && Date.parse(item.endTime) > Date.parse(item.resolvedTime)
        ? item.endTime
        : new Date(Date.parse(item.resolvedTime) + CAPTURE_DURATION_MINUTES * 60_000).toISOString(),
    }]
    : []);
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
  const schedule = input.schedule ?? await readFreeSlotSchedule(input.uid, { startsAt: first, endsAt: last }, input.storage, input.now);
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
        if (!intervalCovered(interval, schedule.coverage) || occupied.some((held) => overlaps(interval, held))) continue;
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
  const schedule = await readFreeSlotSchedule(uid, { startsAt: windowStart, endsAt: windowEnd }, options.storage, options.now);
  const held = captureTimedIntervals(contract);
  const items = [] as CaptureProposalContract['items'];
  for (let index = 0; index < contract.items.length; index += 1) {
    const item = contract.items[index]!;
    if (!isEligible(item)) { items.push(item); continue; }
    const dayParts = baseDayPartClarification(item, options.now, options.timezone);
    const base = item.clarification?.questionId
      ? { ...dayParts, questionId: item.clarification.questionId }
      : dayParts;
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
  options: { timezone: string; now: string; held?: readonly TimeInterval[]; storage?: StorageAdapter },
): Promise<boolean> {
  const slots = await findFreeSlots({
    policy: 'capture', uid, timezone: options.timezone, now: options.now,
    dates: [date], durationMinutes: CAPTURE_DURATION_MINUTES,
    held: options.held, limit: 96, minimumSeparationMinutes: 0, storage: options.storage,
  });
  return slots.some((slot) => {
    const local = localTimeSpecFor(new Date(slot.startsAt), options.timezone);
    return local?.date === date && local.time === time;
  });
}
