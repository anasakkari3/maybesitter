import {
  createEmptyDomainState,
  normalizeStoredCommitment,
  type Commitment,
  type DomainState,
  type EscalationState,
  type Reminder,
} from '../../src/domain/stateMachine';
import type { TimeInterval } from '../../src/contracts/v1/planningContracts';
import type { WeeklyBlockDocument } from '../../src/contracts/v1/weeklyBlockContracts';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import { GOOGLE_BUSY_SOURCE_ID } from '../integrations/google/googleConfig';
import { connectionIdFor } from '../integrations/providers/production/storedConnectionStore';
import { expandWeeklySessionsToBusyBlocks } from '../calendar/manualBusy';
import { listBusyBlocksBounded, type BusyBlock, type BusySourceReplacementFence, type CalendarSource } from '../calendar/busyBlocks';
import type { CalendarChoiceState, DeviceRegistration } from '../calendar/calendarChoice';
import type { IcsFeedDocument } from '../calendar/icsFeeds';
import { localDayKey } from '../services/mobile/time';
import {
  BUSY_SOURCE_FENCES,
  CALENDAR_CHOICE,
  CALENDAR_SOURCES,
  COMMITMENTS,
  DEVICE_STALE_STATE,
  ESCALATION_STATES,
  ICS_FEEDS,
  PROVIDER_CONNECTIONS,
  REGISTERED_DEVICE_SOURCES,
  REMINDERS,
  WEEKLY_BLOCKS,
  docIdForKey,
  userCol,
  userSubDoc,
  type StorageTransaction,
} from '../storage';
import type { FreeSlotCoverage, FreeSlotSchedule } from '../planning/freeSlots';

export const AUTO_ADD_SOURCE_LIMIT = 61;
export const AUTO_ADD_BUSY_LIMIT = 1_501;
export const AUTO_ADD_WEEKLY_LIMIT = 101;
export const AUTO_ADD_DOMAIN_LIMIT = 1_001;
export const AUTO_ADD_FRESH_MS = 6 * 60 * 60_000;

interface DeviceStaleState {
  readonly choiceGeneration: number;
  readonly sourceId: string;
  readonly fenceGeneration: number;
  readonly failureStartedAt: string | null;
  readonly version: number;
}

export interface AutoAddSnapshot {
  readonly state: DomainState;
  readonly schedule: FreeSlotSchedule;
  readonly connection: IntegrationConnectionRecord | null;
  /** A reached N+1 limit or unsettled/untrustworthy source fails closed. */
  readonly boundedAndSettled: boolean;
}

function liveCalendarConnection(connection: IntegrationConnectionRecord | null): connection is IntegrationConnectionRecord {
  return Boolean(connection
    && connection.identity.provider === 'google'
    && connection.identity.providerAccountId
    && connection.credentialRef
    && connection.state !== 'revoked'
    && connection.state !== 'not_connected'
    && connection.capabilities.includes('calendar_busy'));
}

function fresh(value: string | null | undefined, nowMs: number): boolean {
  if (!value) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= nowMs && nowMs - at <= AUTO_ADD_FRESH_MS;
}

function stateFrom(
  commitments: readonly { data: Commitment }[],
  reminders: readonly { data: Reminder }[],
  escalations: readonly { data: EscalationState }[],
): DomainState {
  const state = createEmptyDomainState();
  for (const { data } of commitments) state.commitments[data.id] = normalizeStoredCommitment(data);
  for (const { data } of reminders) state.reminders[data.id] = data;
  for (const { data } of escalations) state.escalationStates[data.commitmentId] = data;
  return state;
}

function weeklyOccurrences(
  definitions: readonly WeeklyBlockDocument[],
  busy: readonly BusyBlock[],
  window: TimeInterval,
  now: string,
): Array<TimeInterval & { title: string }> {
  const byId = new Map(definitions.map((block) => [block.id, block] as const));
  const occurrences = new Map<string, TimeInterval & { title: string }>();
  for (const row of busy) {
    if (row.sourceKind !== 'weekly' || !row.sourceId.startsWith('weekly-')) continue;
    const block = byId.get(row.sourceId.slice('weekly-'.length));
    if (!block || Date.parse(row.startAt) >= Date.parse(window.endsAt) || Date.parse(row.endAt) <= Date.parse(window.startsAt)) continue;
    occurrences.set(row.blockId, { startsAt: row.startAt, endsAt: row.endAt, title: block.title });
  }
  const futureStart = Math.max(Date.parse(window.startsAt), Date.parse(now));
  const windowEnd = Date.parse(window.endsAt);
  if (!Number.isFinite(futureStart) || !Number.isFinite(windowEnd) || futureStart >= windowEnd) return Array.from(occurrences.values());
  const weeks = Math.ceil((windowEnd - futureStart) / (7 * 86_400_000)) + 1;
  for (const block of definitions) {
    if (block.status !== 'active') continue;
    const expanded = expandWeeklySessionsToBusyBlocks(
      `weekly-${block.id}`,
      'weekly',
      block.weekdays.map((weekday) => ({ weekday, start: block.start, end: block.end })),
      { timezone: block.timezone, referenceTime: new Date(futureStart).toISOString(), weeks },
    );
    for (const row of expanded.blocks) {
      if (Date.parse(row.startAt) >= windowEnd || Date.parse(row.endAt) <= futureStart) continue;
      if (localDayKey(row.startAt, block.timezone) < block.startsOn || occurrences.has(row.blockId)) continue;
      occurrences.set(row.blockId, { startsAt: row.startAt, endsAt: row.endAt, title: block.title });
    }
  }
  return Array.from(occurrences.values()).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/**
 * The auto-add decision's one bounded transaction snapshot. Every collection
 * below is listed once, and the returned arrays are reused for clash checking
 * and CreateDraft -> Confirm.
 */
export async function loadAutoAddSnapshot(
  tx: StorageTransaction,
  uid: string,
  window: TimeInterval,
  now: string,
): Promise<AutoAddSnapshot> {
  const [sources, busy, weekly, commitments, reminders, escalations, feeds, registrations, staleStates, choice, connection, googleFence] = await Promise.all([
    tx.list<CalendarSource>(userCol(uid, CALENDAR_SOURCES), { limit: AUTO_ADD_SOURCE_LIMIT }),
    listBusyBlocksBounded(tx, uid, AUTO_ADD_BUSY_LIMIT),
    tx.list<WeeklyBlockDocument>(userCol(uid, WEEKLY_BLOCKS), { limit: AUTO_ADD_WEEKLY_LIMIT }),
    tx.list<Commitment>(userCol(uid, COMMITMENTS), { limit: AUTO_ADD_DOMAIN_LIMIT }),
    tx.list<Reminder>(userCol(uid, REMINDERS), { limit: AUTO_ADD_DOMAIN_LIMIT }),
    tx.list<EscalationState>(userCol(uid, ESCALATION_STATES), { limit: AUTO_ADD_DOMAIN_LIMIT }),
    tx.list<IcsFeedDocument>(userCol(uid, ICS_FEEDS), { limit: 6 }),
    tx.list<DeviceRegistration>(userCol(uid, REGISTERED_DEVICE_SOURCES), { limit: 21 }),
    tx.list<DeviceStaleState>(userCol(uid, DEVICE_STALE_STATE), { limit: 21 }),
    tx.get<CalendarChoiceState>(userSubDoc(uid, CALENDAR_CHOICE, 'state')),
    tx.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
    tx.get<BusySourceReplacementFence>(userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID))),
  ]);
  const state = stateFrom(commitments, reminders, escalations);
  const limitsReached = sources.length >= AUTO_ADD_SOURCE_LIMIT
    || busy.length >= AUTO_ADD_BUSY_LIMIT
    || weekly.length >= AUTO_ADD_WEEKLY_LIMIT
    || commitments.length >= AUTO_ADD_DOMAIN_LIMIT
    || reminders.length >= AUTO_ADD_DOMAIN_LIMIT
    || escalations.length >= AUTO_ADD_DOMAIN_LIMIT
    || feeds.length >= 6 || registrations.length >= 21 || staleStates.length >= 21;
  if (limitsReached) {
    return { state, connection, boundedAndSettled: false, schedule: { commitments: [], busyBlocks: [], weeklyBlocks: [], routineProfile: null, coverage: [], complete: false } };
  }

  const sourceRows = sources.map((row) => row.data);
  const sourceById = new Map(sourceRows.map((source) => [source.sourceId, source] as const));
  const registrationBySource = new Map(registrations.map((row) => [row.data.sourceId, row.data] as const));
  const staleBySource = new Map(staleStates.map((row) => [row.data.sourceId, row.data] as const));
  const nowMs = Date.parse(now);
  let settled = choice?.state !== 'purging';
  const coverage: FreeSlotCoverage[] = [];

  const devices = sourceRows.filter((source) => source.kind === 'device');
  if (!choice && devices.length > 0) settled = false;
  if (choice?.state === 'active') {
    const applicableIds = new Set(registrations.filter((row) => row.data.state === 'active').map((row) => row.data.sourceId));
    for (const sourceId of Array.from(applicableIds)) {
      const source = sourceById.get(sourceId);
      const registration = registrationBySource.get(sourceId);
      const stale = staleBySource.get(sourceId);
      const usable = Boolean(source && registration?.state === 'active'
        && source.choiceGeneration === choice.generation
        && source.status === 'active'
        && source.coverageStatus !== 'refreshing' && source.coverageStatus !== 'clearing' && source.coverageStatus !== 'stale'
        && fresh(source.lastSyncedAt, nowMs)
        && (!stale || (stale.choiceGeneration === choice.generation && stale.failureStartedAt === null)));
      if (!usable) settled = false;
      coverage.push({
        sourceId,
        kind: 'device',
        windowStart: source?.windowStart ?? null,
        windowEnd: source?.windowEnd ?? null,
        lifecycle: source?.status ?? 'uploading',
        coverageStatus: usable ? 'settled' : 'stale',
      });
    }
  }

  if (liveCalendarConnection(connection)) {
    const source = sourceById.get(GOOGLE_BUSY_SOURCE_ID);
    const certificate = source?.m5Certificate;
    const usable = Boolean(source && certificate?.v === 1
      && certificate.providerAccountId === connection.identity.providerAccountId
      && certificate.fenceGeneration === (googleFence?.generation ?? 0)
      && certificate.choiceGeneration === (choice?.generation ?? null)
      && fresh(certificate.refreshedAt, nowMs)
      && source.coverageStatus !== 'refreshing' && source.coverageStatus !== 'clearing' && source.coverageStatus !== 'stale');
    if (!usable) settled = false;
    coverage.push({ sourceId: GOOGLE_BUSY_SOURCE_ID, kind: 'google', windowStart: source?.windowStart ?? null,
      windowEnd: source?.windowEnd ?? null, coverageStatus: usable ? 'settled' : 'stale' });
  }

  const connectedIcs = new Set<string>();
  for (const { data: feed } of feeds) {
    const sourceId = `ics:${feed.feedId}`;
    connectedIcs.add(sourceId);
    const source = sourceById.get(sourceId);
    const usable = Boolean(source && feed.status === 'ok' && fresh(feed.lastVerifiedAt, nowMs)
      && source.coverageStatus !== 'refreshing' && source.coverageStatus !== 'clearing' && source.coverageStatus !== 'stale');
    if (!usable) settled = false;
    coverage.push({ sourceId, kind: 'ics', windowStart: source?.windowStart ?? null, windowEnd: source?.windowEnd ?? null,
      status: usable ? 'ok' : 'stale', coverageStatus: usable ? 'settled' : 'stale' });
  }

  if (sourceRows.some((source) => source.status === 'uploading' || source.status === 'clearing' || source.status === 'retiring'
    || source.coverageStatus === 'refreshing' || source.coverageStatus === 'clearing')) settled = false;

  const busyRows = busy.map((row) => row.data);
  return {
    state,
    connection,
    boundedAndSettled: settled,
    schedule: {
      commitments: Object.values(state.commitments),
      busyBlocks: busyRows.filter((row) => row.sourceKind !== 'weekly'
        && (row.sourceKind !== 'ics' || connectedIcs.has(row.sourceId))),
      weeklyBlocks: weeklyOccurrences(weekly.map((row) => row.data), busyRows, window, now),
      routineProfile: null,
      coverage,
      complete: settled,
    },
  };
}
