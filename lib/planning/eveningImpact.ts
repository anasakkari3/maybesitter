import type { CaptureProposalContract, CaptureProposalItemContract, EveningImpactContract } from '../../src/contracts/v1/captureContracts';
import type { Commitment } from '../../src/domain/stateMachine';
import { namesPreparedEvent } from '../../src/extraction/lexicon/eventTitles';
import { effectiveIntervalOf } from '../services/timeCollision';
import { getStorage, type StorageAdapter } from '../storage';
import { readFreeSlotSchedule, type FreeSlotSchedule } from './freeSlots';
import { resolveEveningImpact } from '../release/m4bCapabilities';

interface ClockItem { id: string; title: string; start: string; end: string | null; proposal: boolean; allDay: boolean }
export interface EveningImpactMatch { itemId: string; impact: EveningImpactContract }

function parts(iso: string, timezone: string): { date: string; minutes: number } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return { date, minutes: Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) };
}
function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}
function proposalClock(item: CaptureProposalItemContract): ClockItem | null {
  if (!item.resolvedTime || item.allDayEvent === true || item.generated) return null;
  return { id: item.itemId, title: item.title, start: item.resolvedTime, end: item.endTime ?? null, proposal: true, allDay: false };
}
function commitmentClock(row: Commitment): ClockItem | null {
  if (!['active', 'deferred', 'missed'].includes(row.status) || row.timeSpec.allDay) return null;
  const interval = effectiveIntervalOf(row);
  if (!interval) return null;
  return { id: row.id, title: row.title, start: interval.startsAt, end: interval.endsAt, proposal: false, allDay: false };
}
function isLate(item: ClockItem, timezone: string): boolean {
  const start = parts(item.start, timezone);
  if (!item.end) return start.minutes >= 21 * 60;
  const end = parts(item.end, timezone);
  return end.date !== start.date || end.minutes > 22 * 60;
}
function isMorningPrepared(item: ClockItem, timezone: string): boolean {
  return parts(item.start, timezone).minutes < 12 * 60 && namesPreparedEvent(item.title);
}

export function eveningImpacts(
  items: readonly CaptureProposalItemContract[],
  schedule: Pick<FreeSlotSchedule, 'commitments'>,
  timezone: string,
): EveningImpactMatch[] {
  const proposed = items.map(proposalClock).filter((row): row is ClockItem => Boolean(row));
  const saved = schedule.commitments.map(commitmentClock).filter((row): row is ClockItem => Boolean(row));
  const matches: EveningImpactMatch[] = [];
  for (const evening of proposed.filter((row) => isLate(row, timezone))) {
    const day = parts(evening.start, timezone).date;
    const morning = [...proposed, ...saved].filter((row) => row.id !== evening.id && isMorningPrepared(row, timezone)
      && parts(row.start, timezone).date === nextDate(day)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
    if (morning) matches.push({ itemId: evening.id, impact: { kind: 'late_before_important', role: 'evening', otherTitle: morning.title,
      otherStartsAt: morning.start, otherEndsAt: morning.end, ...(morning.proposal ? { otherInProposal: true } : {}), readiness: null, prep: null } });
  }
  for (const morning of proposed.filter((row) => isMorningPrepared(row, timezone))) {
    if (matches.some((entry) => entry.itemId === morning.id)) continue;
    const morningDate = parts(morning.start, timezone).date;
    const evening = saved.filter((row) => isLate(row, timezone) && nextDate(parts(row.start, timezone).date) === morningDate)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
    if (evening) matches.push({ itemId: morning.id, impact: { kind: 'late_before_important', role: 'important', otherTitle: evening.title,
      otherStartsAt: evening.start, otherEndsAt: evening.end, readiness: null, prep: null } });
  }
  return matches;
}

function samePair(a: EveningImpactContract | undefined, b: EveningImpactContract): boolean {
  return Boolean(a && a.kind === b.kind && a.role === b.role && a.otherTitle === b.otherTitle
    && a.otherStartsAt === b.otherStartsAt && a.otherEndsAt === b.otherEndsAt && a.otherInProposal === b.otherInProposal);
}

export async function withEveningImpacts(contract: CaptureProposalContract, uid: string, options: { timezone: string; now: string; storage?: StorageAdapter }): Promise<CaptureProposalContract> {
  if (!resolveEveningImpact()) return contract;
  const timed = contract.items.filter((item) => item.resolvedTime && !item.generated);
  if (!timed.length) return { ...contract, items: contract.items.map(({ impacts: _impacts, ...item }) => item) };
  const starts = timed.map((item) => item.resolvedTime!).sort();
  const from = new Date(Date.parse(starts[0]!) - 24 * 3_600_000).toISOString();
  const to = new Date(Date.parse(starts.at(-1)!) + 48 * 3_600_000).toISOString();
  const schedule = await readFreeSlotSchedule(uid, { startsAt: from, endsAt: to }, options.storage ?? getStorage(), options.now);
  if (!schedule.complete) return contract;
  const found = new Map(eveningImpacts(contract.items, schedule, options.timezone).map((row) => [row.itemId, row.impact]));
  const liveSources = new Set(found.keys());
  const items = contract.items.filter((item) => !item.generated || liveSources.has(item.generated.sourceItemId)).map((item) => {
    if (item.generated) return item;
    const impact = found.get(item.itemId);
    if (!impact) { const { impacts: _impacts, ...plain } = item; return plain; }
    const old = item.impacts?.[0];
    return { ...item, impacts: [{ ...impact, ...(samePair(old, impact) ? { readiness: old!.readiness, prep: old!.prep } : {}) }] };
  });
  return { ...contract, items };
}
