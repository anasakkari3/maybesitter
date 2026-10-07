/**
 * M3a Task B acceptance gate, shared harness. Written by the gate author
 * (Claude), not a builder. The contract is
 * evidence/claudex-20261006/M3/PLAN-M3a.md v7 and WIRE-M3a.md, the exact
 * shapes; where they differ, WIRE wins on shape and the plan wins on meaning.
 *
 * Every test drives the real routes in-process with fake auth and memory
 * storage. The model is the real provider path with only `@google/genai`
 * stubbed, as `goalGraphModelRoute.test.ts` does, so the route, the cost
 * guard, the validator and the canonical writers all run. The clock is pinned
 * with `mock.timers` to Wednesday 2026-10-07 10:00 in Jerusalem; the tests
 * that need day 15 or 22 move it.
 *
 * The routes do not exist on the gate base. `route()` imports them lazily, so
 * a missing route fails the test that needs it, with its path, instead of
 * crashing the file before any test runs.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { registerHooks } from 'node:module';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../../lib/storage/index.ts';
import { USER_SCOPED_COLLECTIONS, userCol } from '../../../lib/storage/paths.ts';
import { resetProviderForTests } from '../../../src/extraction/llm/index.ts';
import { applyParticipantCommands, getParticipantStateSnapshot } from '../../../lib/services/mobile/participantState.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../../support/fakeAuth.ts';
import { seedGoal } from '../../goalGraph/goalGraphSupport.ts';
import { instantFromLocal } from '../../../src/extraction/timeLexicon.ts';

const BASE = 'http://127.0.0.1:4321';
export const TZ = 'Asia/Jerusalem';
/** Wednesday 2026-10-07, 10:00 in Jerusalem (UTC+3). */
export const REFERENCE = '2026-10-07T07:00:00.000Z';
export const TODAY = '2026-10-07';
export const USER = uidFor('M3aGatePlanOwner');
export const OTHER = uidFor('M3aGatePlanStranger');
export const GOAL_AR = 'بدي أنزل بالوزن'; // I want to lose weight

export function at(date: string, time: string, zone: string = TZ): string {
  return instantFromLocal(date, time, zone)!.toISOString();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── shapes read from the answers (WIRE-M3a.md) ─────────────────────── */

export type PlanStep = {
  stepId: string; order: number; phase: { unit: 'day' | 'week'; index: number };
  title: string; kind: 'commitment' | 'habit'; durationMinutes: number;
  rhythm?: { timesPerWeek: number; timeOfDay?: string };
  buildsOn: string | null; expectedOutcome: string | null; origin: string;
};
export type Plan = {
  planId: string; goalId: string; revision: number; status: string; source: string;
  horizon: 'days' | 'weeks'; steps: PlanStep[]; removedSteps: Array<{ stepId: string; title: string }>;
};
export type Slot = { startsAt: string; endsAt: string };
export type Weekly = { weekdays: number[]; start: string; end: string };
export type TimesStep = {
  stepId: string; kind: 'commitment' | 'habit';
  slot?: Slot | null; weekly?: Weekly | null; later?: { weekIndex: number };
  alternatives?: Array<Slot | Weekly>; reason?: string; choice?: 'proposed' | 'none';
};
export type Times = {
  timesId: string; timesRevision: number; planId: string; planRevision: number;
  anchor: { localDate: string; timezone: string }; steps: TimesStep[];
};

/* ── the model, stubbed at the last hop ─────────────────────────────── */

const GENAI_STUB_URL = 'maybesitter-m3a-gate:google-genai';
const GENAI_STUB_SOURCE = `
export class GoogleGenAI {
  constructor(options) { this.options = options; }
  get models() {
    return { generateContent: async (input) => globalThis.__m3aGateGenerate(input) };
  }
}
`;
type Globals = typeof globalThis & { __m3aGateGenerate?: (input: unknown) => Promise<unknown> };

export type ModelStep = {
  title: string; kind: 'commitment' | 'habit'; phase: { unit: 'day' | 'week'; index: number };
  durationMinutes: number; rhythm?: { timesPerWeek: number; timeOfDay?: string };
  buildsOn: string | null; expectedOutcome: string | null;
  sourceSpans: Array<{ start: number; end: number; text: string }>; inferred: boolean;
};

/** The default plan the stubbed model answers: weeks, two in the first fortnight, one in week 3. */
export function weeksPlan(goalText: string = GOAL_AR): { horizon: 'weeks'; steps: ModelStep[] } {
  return {
    horizon: 'weeks',
    steps: [
      { title: 'امشي نص ساعة', kind: 'commitment', phase: { unit: 'week', index: 1 }, durationMinutes: 30, // walk half an hour
        buildsOn: null, expectedOutcome: 'بتتعوّد تتحرك', sourceSpans: [{ start: 0, end: goalText.length, text: goalText }], inferred: true }, // you get used to moving
      { title: 'رياضة خفيفة', kind: 'habit', phase: { unit: 'week', index: 2 }, durationMinutes: 45, // light exercise
        rhythm: { timesPerWeek: 3, timeOfDay: 'evening' },
        buildsOn: 'بعد ما تعوّدت تمشي', expectedOutcome: 'بتقوى', sourceSpans: [], inferred: true }, // after you got used to walking / you get stronger
      { title: 'قيس وزنك وراجع الأكل', kind: 'commitment', phase: { unit: 'week', index: 3 }, durationMinutes: 20, // weigh yourself and review food
        buildsOn: 'بعد أسبوعين رياضة', expectedOutcome: 'بتعرف وين صرت', sourceSpans: [], inferred: true }, // after two weeks of exercise / you know where you are
    ],
  };
}

/* ── one harness per test ───────────────────────────────────────────── */

export interface Harness {
  readonly storage: MemoryStorageAdapter;
  readonly goalId: string;
  readonly modelCalls: unknown[];
  /** Replace what the model answers next (a JSON value, or a function of the call number). */
  answer(next: unknown | ((call: number) => unknown)): void;
  setTime(iso: string): void;
  restore(): void;
}

export interface SetupOptions {
  readonly env?: Record<string, string | undefined>;
  readonly goalText?: string;
  readonly model?: boolean;
  readonly uid?: string;
}

const ENV_KEYS = ['MAYBESITTER_FEATURE_GOAL_PLAN', 'MAYBESITTER_KILL_SWITCH_GOAL_PLAN', 'MAYBESITTER_ENV',
  'MAYBESITTER_LLM_PROVIDER', 'MAYBESITTER_VERTEX_LOCATION', 'MAYBESITTER_FEATURE_PROACTIVE_LOOP'];

export async function setup(options: SetupOptions = {}): Promise<Harness> {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: Date.parse(REFERENCE) });
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth: FakeAuthControls = installFakeAuth();
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const env = { MAYBESITTER_FEATURE_GOAL_PLAN: 'true', ...(options.env ?? {}) };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const modelCalls: unknown[] = [];
  let next: unknown | ((call: number) => unknown) = weeksPlan(options.goalText);
  (globalThis as Globals).__m3aGateGenerate = async (input) => {
    modelCalls.push(input);
    const value = await (typeof next === 'function' ? (next as (call: number) => unknown)(modelCalls.length) : next);
    if (value instanceof Error) throw value;
    return {
      text: typeof value === 'string' ? value : JSON.stringify(value),
      modelVersion: 'gemini-2.5-flash',
      usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 300 },
    };
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@google/genai') return { url: GENAI_STUB_URL, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === GENAI_STUB_URL) return { format: 'module', source: GENAI_STUB_SOURCE, shortCircuit: true };
      return nextLoad(url, context);
    },
  });
  if (options.model !== false) {
    process.env.MAYBESITTER_LLM_PROVIDER = 'gemini';
    process.env.MAYBESITTER_VERTEX_LOCATION = 'europe-west1';
  } else {
    delete process.env.MAYBESITTER_LLM_PROVIDER;
  }
  resetProviderForTests();

  const { goal } = await seedGoal(options.goalText ?? GOAL_AR, { scopeId: options.uid ?? USER, language: 'ar', storage: getStorage() });
  return {
    storage,
    goalId: goal.id,
    modelCalls,
    answer(value) { next = value; },
    setTime(iso) { mock.timers.setTime(Date.parse(iso)); },
    restore() {
      hooks.deregister();
      delete (globalThis as Globals).__m3aGateGenerate;
      for (const key of ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      resetProviderForTests();
      auth.restore();
      resetStorageForTests();
      mock.timers.reset();
    },
  };
}

/* ── routes, imported lazily ────────────────────────────────────────── */

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function route(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE'): Promise<Handler> {
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

export interface Answer { status: number; body: Record<string, any> }

export async function call(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  params: Record<string, string>,
  body?: unknown,
  uid: string = USER,
): Promise<Answer> {
  const pattern = path;
  const concrete = Object.entries(params).reduce((p, [key, value]) => p.replace(`[${key}]`, value), pattern);
  const handler = await route(pattern, method);
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await handler(
    new Request(`${BASE}/api/mobile/${concrete}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    { params: Promise.resolve(params) },
  );
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) as Record<string, any> : {}; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

let keyCounter = 0;
export function key(label = 'k'): string {
  keyCounter += 1;
  return `m3a-gate-${label}-${keyCounter}-${Date.now()}`;
}

/* ── the flow, step by step ─────────────────────────────────────────── */

export async function generate(goalId: string, body: Record<string, unknown> = {}): Promise<Answer> {
  return call('goals/[goalId]/plan/generate', 'POST', { goalId }, { idempotencyKey: key('gen'), ...body });
}

export async function draftOf(goalId: string): Promise<Plan> {
  const answer = await generate(goalId);
  assert.equal(answer.status, 200, `generate answered ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body.plan as Plan;
}

export async function edit(goalId: string, plan: Plan, op: Record<string, unknown>, revision = plan.revision): Promise<Answer> {
  return call('goals/[goalId]/plans/[planId]', 'PATCH', { goalId, planId: plan.planId }, { revision, op });
}

export async function approve(goalId: string, plan: Plan): Promise<{ plan: Plan; times: Times }> {
  const answer = await call('goals/[goalId]/plans/[planId]/approve', 'POST', { goalId, planId: plan.planId }, { revision: plan.revision });
  assert.equal(answer.status, 200, `approve answered ${answer.status} ${JSON.stringify(answer.body)}`);
  return { plan: answer.body.plan as Plan, times: answer.body.times as Times };
}

export async function choose(goalId: string, times: Times, stepId: string, choice: Record<string, unknown>): Promise<Answer> {
  return call('goals/[goalId]/plans/[planId]/times/[stepId]', 'PATCH', { goalId, planId: times.planId, stepId }, { timesId: times.timesId, timesRevision: times.timesRevision, choice });
}

export async function confirm(goalId: string, times: Times, idempotencyKey: string = key('confirm')): Promise<Answer> {
  return call('goals/[goalId]/plans/[planId]/confirm', 'POST', { goalId, planId: times.planId }, {
    planRevision: times.planRevision, timesId: times.timesId, timesRevision: times.timesRevision, idempotencyKey,
  });
}

/** generate → approve, with the default stubbed plan. */
export async function approved(goalId: string): Promise<{ plan: Plan; times: Times }> {
  return approve(goalId, await draftOf(goalId));
}

/* ── reading what was written ───────────────────────────────────────── */

export async function commitments(uid: string = USER) {
  return Object.values((await getParticipantStateSnapshot(uid)).commitments);
}

export async function rows(collection: string, uid: string = USER): Promise<Array<Record<string, any>>> {
  return (await getStorage().list<Record<string, any>>(userCol(uid, collection))).map((row) => row.data);
}

export async function documentCount(uid: string = USER): Promise<number> {
  let total = 0;
  for (const collection of USER_SCOPED_COLLECTIONS) total += (await getStorage().list(userCol(uid, collection))).length;
  return total;
}

export function overlaps(a: Slot, b: Slot): boolean {
  return Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
}

/* ── a loaded account (owner rule: test under load) ─────────────────── */

let seedCounter = 0;
/**
 * Fills the first two weeks: every day an event 09:00–12:00 and 14:00–17:00,
 * plus 19:00–20:00 on weekdays (Sun–Thu). That is 46 confirmed commitments.
 * What is left is narrow and known, so a slot that ignores the calendar is
 * caught. Returns the busy intervals.
 */
export async function loadCalendar(uid: string = USER, days = 14): Promise<Slot[]> {
  const busy: Slot[] = [];
  const now = new Date().toISOString();
  const commands: any[] = [];
  for (let day = 0; day < days; day += 1) {
    const date = addDays(TODAY, day);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const ranges: Array<[string, string]> = [['09:00', '12:00'], ['14:00', '17:00']];
    if (weekday <= 4) ranges.push(['19:00', '20:00']);
    for (const [start, end] of ranges) {
      seedCounter += 1;
      const id = `0c0ffee0-0000-4000-8000-${String(seedCounter).padStart(12, '0')}`;
      const slot = { startsAt: at(date, start), endsAt: at(date, end) };
      busy.push(slot);
      commands.push(
        { type: 'CreateDraft', now, commitment: { id, kind: 'task', title: `مشغول ${seedCounter}`, // busy N
          timeSpec: { kind: 'scheduled_event', dueAt: slot.startsAt, endAt: slot.endsAt, allDay: false, timezone: TZ } } },
        { type: 'ConfirmCommitment', commitmentId: id, now },
      );
    }
  }
  await applyParticipantCommands(uid, commands);
  return busy;
}

export async function addBusy(slot: Slot, uid: string = USER): Promise<string> {
  seedCounter += 1;
  const id = `0c0ffee1-0000-4000-8000-${String(seedCounter).padStart(12, '0')}`;
  const now = new Date().toISOString();
  await applyParticipantCommands(uid, [
    { type: 'CreateDraft', now, commitment: { id, kind: 'task', title: 'موعد جديد', // a new appointment
      timeSpec: { kind: 'scheduled_event', dueAt: slot.startsAt, endAt: slot.endsAt, allDay: false, timezone: TZ } } } as any,
    { type: 'ConfirmCommitment', commitmentId: id, now } as any,
  ]);
  return id;
}

export function stepTimes(times: Times, stepId: string): TimesStep {
  const step = times.steps.find((entry) => entry.stepId === stepId);
  assert.ok(step, `times has no entry for step ${stepId}`);
  return step!;
}

export function stepByTitle(plan: Plan, title: string): PlanStep {
  const step = plan.steps.find((entry) => entry.title === title);
  assert.ok(step, `plan has no step «${title}»: ${plan.steps.map((s) => s.title).join(' | ')}`);
  return step!;
}
