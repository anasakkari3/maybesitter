/**
 * M3b Gate B, shared harness (PLAN-M3b r1–r7, WIRE-M3b). Gate author: Claude,
 * written before Task B's build; every test must fail on 80eea528 for the
 * reason its criterion names.
 *
 * It reuses the M2b harness (real routes in-process, fake auth, memory
 * storage, a fixed reference time Wednesday 2026-10-07 10:00 Jerusalem) and
 * adds the M3b switches: `captureKinds` on (it is default-off everywhere,
 * R3-001), the memory module on so goals can be written, and the three new
 * readers (habits, goals, seeds). Routes that do not exist yet are imported
 * lazily so a missing route fails its test, not the whole file.
 *
 * Copy is the builders' to choose: only statuses, reasons, ids, shapes and
 * what is persisted are asserted.
 */
import assert from 'node:assert/strict';
import { tokenFor } from '../../support/fakeAuth.ts';
import { listMemory } from '../../../lib/services/mobile/memoryService.ts';
import {
  REFERENCE,
  TZ,
  beginModel as beginModelM2b,
  beginRules as beginRulesM2b,
  chatRaw,
  confirmRaw,
  currentStorage,
  end as endM2b,
  keptSeeds,
  savedCommitments,
  show,
  type Raw,
} from '../m2b/support.ts';

export { REFERENCE, TZ, chatRaw, confirmRaw, currentStorage, keptSeeds, savedCommitments, show };
export type { Raw };

const BASE = 'http://localhost:3000';

const ENV_KEYS = [
  'MAYBESITTER_FEATURE_CAPTURE_KINDS',
  'MAYBESITTER_KILL_SWITCH_CAPTURE_KINDS',
  'MAYBESITTER_FEATURE_MEMORY',
  'MAYBESITTER_ENV',
] as const;
let saved: Record<string, string | undefined> | null = null;

export interface Switches {
  /** `captureKinds` (default true here). */
  kinds?: boolean;
  /** The kill switch (default false). */
  killed?: boolean;
  /** The memory module, which goal writes need (default true). */
  memory?: boolean;
  /** MAYBESITTER_ENV (default 'test'). */
  environment?: string;
}

export function setSwitches(switches: Switches = {}): void {
  if (saved === null) saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const kinds = switches.kinds ?? true;
  process.env.MAYBESITTER_FEATURE_CAPTURE_KINDS = kinds ? 'true' : 'false';
  process.env.MAYBESITTER_KILL_SWITCH_CAPTURE_KINDS = switches.killed ? 'true' : 'false';
  process.env.MAYBESITTER_FEATURE_MEMORY = (switches.memory ?? true) ? 'true' : 'false';
  process.env.MAYBESITTER_ENV = switches.environment ?? 'test';
}

export function beginRules(switches: Switches = {}): string {
  const uid = beginRulesM2b();
  setSwitches(switches);
  return uid;
}

export function beginModel(switches: Switches, ...answers: unknown[]): string {
  const uid = beginModelM2b(...answers);
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
}

/* ── shapes (WIRE-M3b) ─────────────────────────────────────────────── */

export type Cadence = { kind: 'weekly_count'; count: number } | { kind: 'weekdays'; weekdays: number[] };
export type HabitPoint = {
  habitItemId: string;
  pointId: string;
  title: string;
  cadence: Cadence | null;
  durationMinutes: number | null;
  preferredWindow: unknown;
  explanation: string | null;
  question: { field: 'frequency' | 'duration' | 'kind'; options: unknown[] } | null;
  confirmable: boolean;
};
export type GoalPoint = { goalItemId: string; pointId: string; title: string };
export type SeedPoint = { seedItemId: string; pointId?: string; kind: string; summary: string; suggestedTime?: { at: string; timeZone: string } | null };
export type ItemPoint = { itemId: string; pointId?: string; title: string; resolvedTime?: string | null };
export type Proposal = {
  proposalId: string;
  revision?: number;
  entry?: string | null;
  items: ItemPoint[];
  seeds: SeedPoint[];
  habits?: HabitPoint[];
  goals?: GoalPoint[];
  understood?: Array<Record<string, unknown>>;
};
export type Answer = { conversationId: string; reply: string; engine: 'model' | 'rules'; proposal: Proposal | null };

export interface SayOptions {
  entry?: 'goal' | 'habit' | 'thought';
  conversationId?: string;
  locale?: 'ar' | 'en' | 'he';
}

/** One chat message, with the M3b `entry` hint on a first turn. */
export async function say(uid: string, message: string, options: SayOptions = {}): Promise<Answer> {
  const result = await chatRaw(uid, {
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    message,
    timezone: TZ,
    referenceTime: REFERENCE,
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.entry ? { entry: options.entry } : {}),
  });
  assert.equal(result.status, 200, `chat answered ${result.status}: ${show(result.body)}`);
  return result.body as Answer;
}

/** A structured edit on any of the four families (WIRE-M3b). */
export async function editPoint(
  uid: string,
  answer: Answer,
  target: { itemId: string } | { seedItemId: string } | { habitItemId: string } | { goalItemId: string },
  change: Record<string, unknown>,
): Promise<Raw> {
  assert.ok(answer.proposal, `nothing to edit: ${show(answer)}`);
  return chatRaw(uid, {
    conversationId: answer.conversationId,
    edit: { proposalId: answer.proposal!.proposalId, revision: answer.proposal!.revision ?? 0, target, change },
    timezone: TZ,
    referenceTime: REFERENCE,
  });
}

export function habitsOf(answer: Answer): HabitPoint[] {
  const habits = answer.proposal?.habits;
  assert.ok(Array.isArray(habits), `the proposal carries no habits[] (v8): ${show(answer.proposal)}`);
  return habits!;
}

export function goalsOf(answer: Answer): GoalPoint[] {
  const goals = answer.proposal?.goals;
  assert.ok(Array.isArray(goals), `the proposal carries no goals[] (v8): ${show(answer.proposal)}`);
  return goals!;
}

let keyCounter = 0;
export function confirmKey(label = 'k'): string {
  keyCounter += 1;
  return `m3b-gate-${label}-${keyCounter}`;
}

export interface Selection {
  items?: string[];
  habits?: string[];
  goals?: string[];
  seeds?: string[];
  key?: string;
}

export async function confirm(uid: string, proposal: Proposal, selection: Selection): Promise<Raw> {
  return confirmRaw(uid, {
    proposalId: proposal.proposalId,
    selectedItemIds: selection.items ?? [],
    selectedHabitItemIds: selection.habits ?? [],
    selectedGoalItemIds: selection.goals ?? [],
    selectedSeedItemIds: selection.seeds ?? [],
    idempotencyKey: selection.key ?? confirmKey(),
  });
}

/* ── readers ───────────────────────────────────────────────────────── */

async function getRoute(path: string, uid: string): Promise<Raw> {
  let module: Record<string, unknown>;
  try {
    module = await import(`../../../src/app/api/mobile/${path}/route.ts`) as Record<string, unknown>;
  } catch (error) {
    assert.fail(`route not built: src/app/api/mobile/${path}/route.ts (${(error as Error).message.split('\n')[0]})`);
  }
  const handler = module.GET as (request: Request) => Promise<Response>;
  assert.equal(typeof handler, 'function', `route ${path} has no GET`);
  const response = await handler(new Request(`${BASE}/api/mobile/${path}`, { headers: { authorization: `Bearer ${tokenFor(uid)}` } }));
  const text = await response.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* left as text */ }
  return { status: response.status, body };
}

/** `GET /api/mobile/capture/kinds` (R004). */
export function probe(uid: string): Promise<Raw> {
  return getRoute('capture/kinds', uid);
}

export type SavedHabit = {
  habitId: string;
  title: string;
  source: string;
  cadence: Cadence;
  durationMinutes: number;
  preferredWindows: unknown[];
  minimumOccurrences: number;
  maximumOccurrences: number;
  flexibility: string;
  recoveryPolicy: string;
  confirmation: Record<string, unknown>;
};

export async function savedHabits(uid: string): Promise<SavedHabit[]> {
  const result = await getRoute('habits', uid);
  assert.equal(result.status, 200, `GET /habits answered ${result.status}: ${show(result.body)}`);
  const list = result.body.items;
  assert.ok(Array.isArray(list), `GET /habits: no list in ${show(result.body)}`);
  return list as SavedHabit[];
}

/** The account's goal memories, as the memory service lists them (with provenance). */
export async function savedGoals(uid: string): Promise<Array<Record<string, any>>> {
  const records = await listMemory(uid, new Date(Date.parse(REFERENCE) + 60_000).toISOString());
  return (records as unknown as Array<Record<string, any>>).filter((record) => record.kind === 'goal');
}

/** The keys contract v8 adds; none may appear when `captureKinds` is off (R3-003). */
export const V8_KEYS = ['habits', 'goals', 'pointId', 'entry', 'suggestedTime', 'habitsPersisted', 'goalsPersisted', 'seedsPersisted'] as const;

export function v8KeysIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => v8KeysIn(entry, found));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if ((V8_KEYS as readonly string[]).includes(key)) found.add(key);
      v8KeysIn(entry, found);
    }
  }
  return found;
}
