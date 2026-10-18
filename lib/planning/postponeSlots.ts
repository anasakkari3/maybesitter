import { createHmac, timingSafeEqual } from 'node:crypto';
import { applyCommand as applyDomainCommand, type Commitment, type DomainState } from '../../src/domain/stateMachine';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon';
import { addCivilDays } from '../services/dailyPlan/dailyPlanService';
import { fixedStartOf } from '../services/dailyPlan/buildDailyPlan';
import { clockLengthOf } from '../services/timeCollision';
import {
  ClientActionIdReusedError,
  COMMITMENT_ACTION_RECEIPT_TTL_MS,
  commitmentActionReceiptPath,
  loadDomainState,
  writeDomainDiff,
  type CommitmentActionReceipt,
} from '../services/mobile/participantState';
import { personalizationGrowthAllowed } from '../consents/personalizationConsentService';
import { keptFocusWindow } from '../memoryGrowth/suggestionService';
import { getStorage, userDoc, type StorageAdapter } from '../storage';
import type { UserDocument } from '../storage/userDocument';
import { readActivityStats, recordActivityEvents } from '../services/activity/activityStats';
import {
  candidateClashes,
  findFreeSlots,
  readFreeSlotSchedule,
  runScheduleDecisionHook,
  type FreeSlotSchedule,
} from './freeSlots';

const DAY = 86_400_000;
const TOKEN_LIFETIME = 15 * 60_000;

export type PostponeWhy = 'soonest' | 'light_day' | 'usual_time';
export interface PostponeSlot { startsAt: string; endsAt: string; localDate: string; localTime: string; why: PostponeWhy; slotToken: string }
interface TokenPayload { uid: string; id: string; version: string; start: string; end: string; exp: number }

function b64(value: string): string { return Buffer.from(value).toString('base64url'); }
function signature(encoded: string, key: string): string { return createHmac('sha256', key).update(encoded).digest('base64url'); }
function versionOf(row: Commitment): string {
  return b64(JSON.stringify({ updatedAt: row.updatedAt, timeSpec: row.timeSpec, postponedUntil: row.postponedUntil }));
}
function signSlot(uid: string, row: Commitment, start: string, end: string, now: Date): string {
  const key = process.env.MAYBESITTER_POSTPONE_SLOT_HMAC_KEY!;
  const encoded = b64(JSON.stringify({ uid, id: row.id, version: versionOf(row), start, end, exp: now.getTime() + TOKEN_LIFETIME } satisfies TokenPayload));
  return `${encoded}.${signature(encoded, key)}`;
}
function tokenPayload(token: string): TokenPayload | null {
  const key = process.env.MAYBESITTER_POSTPONE_SLOT_HMAC_KEY;
  if (!key) return null;
  const [encoded, mac, extra] = token.split('.');
  if (!encoded || !mac || extra) return null;
  const expected = signature(encoded, key);
  const left = Buffer.from(mac); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload; } catch { return null; }
}

function localDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function localTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function usualHoursFor(state: DomainState, timezone: string, key: string, now = new Date()): { startHour: number; endHour: number } | null {
  const cutoff = now.getTime() - 28 * DAY;
  const all = Object.values(state.commitments).filter((row) => row.completedAt && Date.parse(row.completedAt) >= cutoff);
  const keyed = all.filter((row) => (row.category ?? row.kind) === key);
  const clustered = (sample: Commitment[]): { startHour: number; endHour: number } | null => {
    if (sample.length < 8) return null;
    const counts = Array.from({ length: 8 }, () => 0);
    for (const row of sample) {
      const hour = Number(localTime(row.completedAt!, timezone).slice(0, 2));
      counts[Math.floor(hour / 3)]! += 1;
    }
    let best = 0;
    for (let index = 1; index < counts.length; index += 1) if (counts[index]! > counts[best]!) best = index;
    return counts[best]! / sample.length >= 0.6 ? { startHour: best * 3, endHour: best * 3 + 3 } : null;
  };
  return clustered(keyed) ?? clustered(all);
}

export interface RankInputs { commitment: Commitment; schedule: FreeSlotSchedule; timezone: string; now: string; usualHours?: { startHour: number; endHour: number } | null }
export function rankPostponeSlots(candidates: Array<{ startsAt: string; endsAt: string }>, inputs: RankInputs): Array<{ startsAt: string; endsAt: string; why: PostponeWhy }> {
  const dayLoads = new Map<string, number>();
  const add = (start: string, end: string) => {
    const day = localDate(start, inputs.timezone);
    const minutes = Math.max(0, (Date.parse(end) - Date.parse(start)) / 60_000);
    dayLoads.set(day, (dayLoads.get(day) ?? 0) + minutes);
  };
  for (const row of inputs.schedule.commitments) {
    if (row.id === inputs.commitment.id || row.status === 'dropped' || row.status === 'completed' || row.timeSpec.allDay || !row.timeSpec.dueAt) continue;
    const start = row.postponedUntil ?? row.timeSpec.dueAt;
    add(start, new Date(Date.parse(start) + clockLengthOf(row) * 60_000).toISOString());
  }
  for (const row of inputs.schedule.busyBlocks) if (!row.allDay) add(row.startAt, row.endAt);
  for (const row of inputs.schedule.weeklyBlocks) add(row.startsAt, row.endsAt);
  const important = inputs.commitment.priority.level === 'high'
    || Boolean(inputs.commitment.timeSpec.kind === 'due_by' && inputs.commitment.timeSpec.dueAt
      && Date.parse(inputs.commitment.timeSpec.dueAt) - Date.parse(inputs.now) <= 48 * 3_600_000);
  const scored = candidates.map((slot) => {
    const day = localDate(slot.startsAt, inputs.timezone);
    const load = (dayLoads.get(day) ?? 0) / (14 * 60);
    const hour = Number(localTime(slot.startsAt, inputs.timezone).slice(0, 2));
    const usual = Boolean(inputs.usualHours && hour >= inputs.usualHours.startHour && hour < inputs.usualHours.endHour);
    const days = Math.max(0, (Date.parse(slot.startsAt) - Date.parse(inputs.now)) / DAY);
    const score = (important ? days * 1000 : days * 8) + load * 600 - (usual ? 900 : 0);
    const why: PostponeWhy = usual ? 'usual_time' : load <= 0.6 && Array.from(dayLoads.values()).some((value) => value / (14 * 60) > 0.6) ? 'light_day' : 'soonest';
    return { ...slot, day, load, score, why };
  });
  const eligible = scored.some((row) => row.load <= 0.85) ? scored.filter((row) => row.load <= 0.85) : scored;
  eligible.sort((a, b) => a.score - b.score || Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const perDay = new Map<string, number>();
  return eligible.filter((row) => {
    const count = perDay.get(row.day) ?? 0;
    if (count >= 2) return false;
    perDay.set(row.day, count + 1);
    return true;
  }).slice(0, 3).map(({ startsAt, endsAt, why }) => ({ startsAt, endsAt, why }));
}

export async function postponeSlots(uid: string, id: string, options: { storage?: StorageAdapter; now?: Date } = {}): Promise<{ complete: boolean; slots: PostponeSlot[] } | null> {
  const storage = options.storage ?? getStorage(); const now = options.now ?? new Date();
  // Consent is checked before loading completion history or categories. Slot
  // generation still works without it; only the habit term is omitted.
  const consent = await personalizationGrowthAllowed(uid, { storage });
  const [state, user] = await Promise.all([loadDomainState(storage, uid), storage.get<UserDocument>(userDoc(uid))]);
  const row = state.commitments[id];
  if (!row) return null;
  if (!['active', 'deferred', 'missed'].includes(row.status)) throw new Error('not_postponable');
  const timezone = user?.timezone || row.timeSpec.timezone || 'UTC';
  const today = localTimeSpecFor(now, timezone)?.date;
  if (!today) return { complete: false, slots: [] };
  const important = row.priority.level === 'high' || Boolean(row.timeSpec.kind === 'due_by' && row.timeSpec.dueAt
    && Date.parse(row.timeSpec.dueAt) - now.getTime() <= 48 * 3_600_000);
  const days = Array.from({ length: important ? 4 : 8 }, (_, index) => addCivilDays(today, index));
  const from = new Date(now.getTime() + 60 * 60_000).toISOString();
  const to = new Date(Date.parse(`${days.at(-1)}T23:59:59.999Z`) + DAY).toISOString();
  const schedule = await readFreeSlotSchedule(uid, { startsAt: from, endsAt: to }, storage, now.toISOString());
  if (!schedule.complete) return { complete: false, slots: [] };
  const withoutOwn = { ...schedule, commitments: schedule.commitments.filter((candidate) => candidate.id !== id) };
  const durationMinutes = clockLengthOf(row);
  const movable = row.timeSpec.allDay !== true && Boolean(row.timeSpec.dueAt)
    && (row.timeSpec.kind === 'scheduled_event' || (row.timeSpec.kind === 'due_by' && Boolean(row.timeSpec.endAt)));
  const currentStart = movable ? fixedStartOf(row) : null;
  const found: Array<{ startsAt: string; endsAt: string }> = [];
  for (const date of days) {
    const day = await findFreeSlots({ policy: 'capture', uid, timezone, now: now.toISOString(), dates: [date], durationMinutes, schedule: withoutOwn, limit: 100, minimumSeparationMinutes: 90, storage });
    for (const slot of day) {
      if (currentStart && Date.parse(slot.startsAt) <= Date.parse(currentStart)) continue;
      if (candidateClashes(withoutOwn, { dueAt: slot.startsAt, endAt: slot.endsAt, kind: 'scheduled_event' }, { excludeCommitmentIds: [id] }).state === 'free') found.push(slot);
    }
  }
  let usual = consent ? usualHoursFor(state, timezone, row.category ?? row.kind, now) : null;
  if (consent && !usual) {
    const focus = await keptFocusWindow(uid, now.toISOString(), { storage });
    if (focus) usual = { startHour: Number(focus.start.slice(0, 2)), endHour: Number(focus.end.slice(0, 2)) };
  }
  const ranked = rankPostponeSlots(found, { commitment: row, schedule: withoutOwn, timezone, now: now.toISOString(), usualHours: usual });
  return { complete: true, slots: ranked.map((slot) => ({ ...slot, localDate: localDate(slot.startsAt, timezone), localTime: localTime(slot.startsAt, timezone), slotToken: signSlot(uid, row, slot.startsAt, slot.endsAt, now) })) };
}

export class SlotDecisionError extends Error { constructor(readonly code: 'slot_taken' | 'slot_unverified' | 'slot_stale') { super(code); } }

export async function applyPostponeSlot(uid: string, id: string, input: { postponedUntil: string; slotToken: string; clientActionId?: string }): Promise<{ commitment: Commitment; replayed: boolean }> {
  const storage = getStorage(); const now = new Date();
  let replayed = false;
  await storage.runTransaction(async (tx) => {
    const fingerprint = `postpone|${input.postponedUntil}|fromSlot:true|${input.slotToken}`;
    const receiptPath = input.clientActionId ? commitmentActionReceiptPath(uid, input.clientActionId) : null;
    const existing = receiptPath ? await tx.get<CommitmentActionReceipt>(receiptPath) : null;
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.commitmentId !== id) throw new ClientActionIdReusedError();
      replayed = true; return;
    }
    const [state, user, stats] = await Promise.all([
      loadDomainState(tx, uid),
      tx.get<UserDocument>(userDoc(uid)),
      readActivityStats(tx, uid),
    ]);
    const row = state.commitments[id];
    if (!row) throw new Error('Commitment not found');
    const payload = tokenPayload(input.slotToken);
    if (!payload || payload.uid !== uid || payload.id !== id || payload.version !== versionOf(row)
      || payload.start !== input.postponedUntil || payload.exp < now.getTime()) throw new SlotDecisionError('slot_stale');
    const schedule = await readFreeSlotSchedule(uid, { startsAt: payload.start, endsAt: payload.end }, tx as unknown as StorageAdapter, now.toISOString());
    const decision = candidateClashes(schedule, { dueAt: payload.start, endAt: payload.end, kind: 'scheduled_event' }, { excludeCommitmentIds: [id] });
    await runScheduleDecisionHook('postpone');
    if (decision.state === 'unknown') throw new SlotDecisionError('slot_unverified');
    if (decision.state === 'clash') throw new SlotDecisionError('slot_taken');
    const spec = row.timeSpec;
    const movable = spec.allDay !== true && Boolean(spec.dueAt)
      && (spec.kind === 'scheduled_event' || (spec.kind === 'due_by' && Boolean(spec.endAt)));
    const delta = movable && spec.dueAt ? Date.parse(payload.start) - Date.parse(spec.dueAt) : 0;
    const command = { type: 'Postpone' as const, commitmentId: id, postponedUntil: payload.start, now: now.toISOString(), ...(movable ? { moveInterval: {
      dueAt: payload.start,
      endAt: spec.endAt ? new Date(Date.parse(spec.endAt) + delta).toISOString() : null,
      remindAt: spec.remindAt ? new Date(Date.parse(spec.remindAt) + delta).toISOString() : null,
    } } : {}) };
    let transition;
    try { transition = applyDomainCommand(state, command); } catch { throw new Error('not_postponable'); }
    if (transition.didChange) {
      writeDomainDiff(tx, uid, state, transition.newState, transition.events, user, now.toISOString());
      recordActivityEvents(tx, uid, stats, transition.events);
    }
    if (receiptPath && input.clientActionId) tx.create<CommitmentActionReceipt>(receiptPath, {
      clientActionId: input.clientActionId, commitmentId: id, fingerprint,
      result: transition.didChange ? 'applied' : 'noop', createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + COMMITMENT_ACTION_RECEIPT_TTL_MS),
    });
  });
  const state = await loadDomainState(storage, uid);
  const commitment = state.commitments[id];
  if (!commitment) throw new Error('Commitment not found');
  return { commitment, replayed };
}
