/**
 * M4a Gate B, shared harness (PLAN-M4a, APPROVED at review r21; WIRE-M4a).
 * Gate author: Claude, written before Task B's build. Every test must fail on
 * ece27abf for the reason its criterion names, except the three parity guards
 * (capture M4A-R2-001 and M4A-R2-002, busyRead M4A-R18-002), which pin
 * today's behaviour and pass on ece27abf by design.
 *
 * Capture tests reuse the M2b harness (real routes in-process, fake auth,
 * memory storage, the rules path). The process clock is pinned to REFERENCE
 * (Wednesday 2026-10-07 10:00 Jerusalem) and every request carries it, so a
 * free slot is computed against a known "now". The free-slot capability is
 * switched on here (default-off everywhere). Routes that do not exist yet are
 * imported lazily, so a missing route fails its own test only.
 *
 * Copy belongs to the builders: only statuses, reasons, ids, shapes, instants
 * and what is persisted are asserted.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { tokenFor } from '../../support/fakeAuth.ts';
import { applyParticipantCommands } from '../../../lib/services/mobile/participantState.ts';
import {
  REFERENCE,
  TZ,
  TODAY,
  TOMORROW,
  at,
  beginRules as beginRulesM2b,
  chatRaw,
  clarifyRaw,
  confirmRaw,
  currentStorage,
  end as endM2b,
  editRaw,
  savedCommitments,
  show,
  type Raw,
} from '../m2b/support.ts';

export { REFERENCE, TZ, TODAY, TOMORROW, at, chatRaw, clarifyRaw, confirmRaw, currentStorage, editRaw, savedCommitments, show };
export type { Raw };

const BASE = 'http://localhost:3000';

const ENV_KEYS = [
  'MAYBESITTER_FEATURE_FREE_SLOTS',
  'MAYBESITTER_KILL_SWITCH_FREE_SLOTS',
  'MAYBESITTER_FEATURE_CAPTURE_KINDS',
  'MAYBESITTER_ENV',
] as const;
let saved: Record<string, string | undefined> | null = null;

export interface Switches {
  /** `freeSlots` (default true here). */
  freeSlots?: boolean;
  /** Its kill switch (default false). */
  killed?: boolean;
  /** M3b `captureKinds`, for the conversion writers (default false). */
  kinds?: boolean;
  /** MAYBESITTER_ENV (default 'test'). */
  environment?: string;
}

export function setSwitches(switches: Switches = {}): void {
  if (saved === null) saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.MAYBESITTER_FEATURE_FREE_SLOTS = (switches.freeSlots ?? true) ? 'true' : 'false';
  process.env.MAYBESITTER_KILL_SWITCH_FREE_SLOTS = switches.killed ? 'true' : 'false';
  process.env.MAYBESITTER_FEATURE_CAPTURE_KINDS = switches.kinds ? 'true' : 'false';
  process.env.MAYBESITTER_ENV = switches.environment ?? 'test';
}

/** The rules path, the clock pinned to REFERENCE, the switches set. */
export function begin(switches: Switches = {}): string {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: Date.parse(REFERENCE) });
  const uid = beginRulesM2b();
  setSwitches(switches);
  return uid;
}

export function end(): void {
  if (saved) {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    saved = null;
  }
  endM2b();
  mock.timers.reset();
}

/* ── shapes (WIRE-M4a) ─────────────────────────────────────────────── */

export type Option = { optionId: string; labelKey: string; labelParams: Record<string, string>; value: { localDate?: string; localTime?: string } };
export type Clarification = { questionId: string; field: string; questionKey: string; options: Option[]; allowFreeText: boolean };
export type Item = { itemId: string; pointId?: string; title: string; resolvedTime: string | null; endTime?: string | null; needsClarification: boolean; clarification: Clarification | null };
export type Proposal = { proposalId: string; revision?: number; items: Item[]; seeds: Array<Record<string, any>>; habits?: Array<Record<string, any>> };
export type Answer = { conversationId: string; proposal: Proposal | null };

export async function say(uid: string, message: string, options: { conversationId?: string; entry?: 'habit' | 'goal' | 'thought' } = {}): Promise<Answer> {
  const result = await chatRaw(uid, {
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    message,
    timezone: TZ,
    referenceTime: REFERENCE,
    locale: 'ar',
    ...(options.entry ? { entry: options.entry } : {}),
  });
  assert.equal(result.status, 200, `chat answered ${result.status}: ${show(result.body)}`);
  return result.body as Answer;
}

/** The untimed item whose title contains `words`. */
export function untimed(answer: Answer, words: string): Item {
  const item = answer.proposal?.items.find((candidate) => candidate.title.includes(words));
  assert.ok(item, `no item «${words}»: ${show(answer.proposal)}`);
  assert.equal(item!.resolvedTime, null, `«${words}» already has a time: ${show(item)}`);
  return item!;
}

/** The `freeSlot` options of an item, in order. */
export function slotsOf(item: Item): Option[] {
  return (item.clarification?.options ?? []).filter((option) => option.labelKey === 'freeSlot');
}

/** A slot's absolute start. */
export function slotStart(option: Option): string {
  assert.ok(option.value.localDate && option.value.localTime, `a slot without a date/time: ${show(option)}`);
  return at(option.value.localDate!, option.value.localTime!);
}

export const DAYPART_IDS = ['morning', 'afternoon', 'evening'];

/* ── occupancy writers ─────────────────────────────────────────────── */

let seedCounter = 0;
export type Slot = { startsAt: string; endsAt: string };

/** A confirmed scheduled event (blocks its interval). */
export async function addEvent(uid: string, slot: Slot, title = 'موعد'): Promise<string> { // an appointment
  seedCounter += 1;
  const id = `0c0ffee4-0000-4000-8000-${String(seedCounter).padStart(12, '0')}`;
  const now = new Date().toISOString();
  await applyParticipantCommands(uid, [
    { type: 'CreateDraft', now, commitment: { id, kind: 'task', title,
      timeSpec: { kind: 'scheduled_event', dueAt: slot.startsAt, endAt: slot.endsAt, allDay: false, timezone: TZ } } } as any,
    { type: 'ConfirmCommitment', commitmentId: id, now } as any,
  ]);
  return id;
}

/**
 * Tomorrow (Thursday 2026-10-08) loaded: 09:00–12:00, 14:00–17:00 and
 * 19:00–20:00. Free inside 08:00–22:00: 08:00–09:00, 12:00–14:00,
 * 17:00–19:00, 20:00–22:00.
 */
export async function loadTomorrow(uid: string): Promise<Slot[]> {
  const ranges: Array<[string, string]> = [['09:00', '12:00'], ['14:00', '17:00'], ['19:00', '20:00']];
  const slots = ranges.map(([start, endTime]) => ({ startsAt: at(TOMORROW, start), endsAt: at(TOMORROW, endTime) }));
  for (const slot of slots) await addEvent(uid, slot);
  return slots;
}

export function overlaps(a: Slot, b: Slot): boolean {
  return Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
}

export function slotInterval(option: Option, minutes = 30): Slot {
  const startsAt = slotStart(option);
  return { startsAt, endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString() };
}

/* ── routes, imported lazily ────────────────────────────────────────── */

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function route(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'): Promise<Handler> {
  let module: Record<string, unknown>;
  try {
    module = await import(`../../../src/app/api/mobile/${path}/route.ts`) as Record<string, unknown>;
  } catch (error) {
    assert.fail(`route not built: src/app/api/mobile/${path}/route.ts (${(error as Error).message.split('\n')[0]})`);
  }
  const handler = module[method];
  assert.equal(typeof handler, 'function', `route ${path} has no ${method} handler`);
  return handler as Handler;
}

/** Any route, in-process, as `uid`. `query` is appended to the URL. */
export async function call(
  uid: string,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  options: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {},
): Promise<Raw> {
  const params = options.params ?? {};
  const concrete = Object.entries(params).reduce((p, [key, value]) => p.replace(`[${key}]`, value), path);
  const handler = await route(path, method);
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const search = options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
  const response = await handler(
    new Request(`${BASE}/api/mobile/${concrete}${search}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }),
    { params: Promise.resolve(params) },
  );
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* left as text */ }
  return { status: response.status, body };
}

/* ── the named seams (the gate's, for Task B to export) ─────────────── */

/**
 * `setFreeSlotScheduleReaderForTests(reader | null)` from
 * `lib/planning/freeSlots.ts`: wraps the dedicated schedule read so a test can
 * count calls and inject a failure into one of its sources. `reader` receives
 * the default reader and returns a replacement.
 */
export type ScheduleSource = 'commitments' | 'busyBlocks' | 'weeklyBlocks' | 'routineProfile';
export async function scheduleSeam(): Promise<(wrap: ((original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>) | null) => void> {
  let module: Record<string, unknown>;
  try {
    module = await import('../../../lib/planning/freeSlots.ts') as Record<string, unknown>;
  } catch (error) {
    assert.fail(`lib/planning/freeSlots.ts not built (${(error as Error).message.split('\n')[0]})`);
  }
  const seam = module.setFreeSlotScheduleReaderForTests;
  assert.equal(typeof seam, 'function', 'setFreeSlotScheduleReaderForTests is not exported (the gate\'s named seam)');
  return seam as any;
}

/**
 * `setFreeSlotSourceFailureForTests(source | null)` from the same module: the
 * next schedule reads throw while reading `source`.
 */
export async function failureSeam(): Promise<(source: ScheduleSource | null) => void> {
  const module = await import('../../../lib/planning/freeSlots.ts').catch((error: Error) => {
    assert.fail(`lib/planning/freeSlots.ts not built (${error.message.split('\n')[0]})`);
  }) as Record<string, unknown>;
  const seam = module.setFreeSlotSourceFailureForTests;
  assert.equal(typeof seam, 'function', 'setFreeSlotSourceFailureForTests is not exported (the gate\'s named seam)');
  return seam as (source: ScheduleSource | null) => void;
}
