/**
 * M5b-1 Gate B, shared harness (PLAN-M5b-1, revised after Codex review r4;
 * its Wire section is binding on shape, its Release section on flag names).
 * Gate author: Claude, written before Task B's build. Every test must fail on
 * dd73a9fb for the reason its criterion names, except the parity guards,
 * which pin today's behaviour and pass on dd73a9fb by design (named "parity"
 * in the test title).
 *
 * Real routes in-process, fake auth, memory storage (the M4a / M4b / M5a
 * harness). The process clock is pinned to REFERENCE (Wednesday 2026-10-07
 * 10:00 Jerusalem) and moved only by `setClock`. MAYBESITTER_ENV is `staging`.
 * The M5b capability (`MAYBESITTER_FEATURE_MEMORY_LEARNING`), the memory
 * module and the next-step module are on unless a test says otherwise. No
 * test reaches a real model: the summary's provider is the gate's fake,
 * installed through the named seam below, and AI is otherwise unconfigured.
 *
 * Copy belongs to the builders: only statuses, error codes, ids, shapes,
 * instants and what is persisted are asserted.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { tokenFor } from '../../support/fakeAuth.ts';
import { applyParticipantCommands, readParticipantState } from '../../../lib/services/mobile/participantState.ts';
import { userDoc } from '../../../lib/storage/paths.ts';
import { createManualMemory } from '../../../lib/services/mobile/memoryService.ts';
import { setRecommendationConsent } from '../../../lib/consents/recommendationConsentService.ts';
import { resetMobilePilotDecisionReplaysForTests } from '../../../lib/services/mobile/pilotService.ts';
import { RECOMMENDATION_CONSENT_VERSION } from '../../../src/contracts/v1/consentContracts.ts';
import { READINESS_CONTEXT_SCHEMA_VERSION } from '../../../lib/userState/userStateService.ts';
import { planPath, readStoredPlan, type StoredDailyPlan } from '../../../lib/services/dailyPlan/planStore.ts';
import {
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  type ReadinessSnapshot,
} from '../../../src/contracts/v1/readinessContracts.ts';
import type { LlmProvider, LlmResponse, LlmStructuredRequest, LlmRequest } from '../../../src/extraction/llm/index.ts';
import { seedLiveAccount } from '../../support/liveAccount.ts';
import {
  REFERENCE,
  TZ,
  TODAY,
  TOMORROW,
  at,
  begin as beginM4b,
  currentStorage,
  end as endM4b,
  show,
  type Raw,
} from '../m4b/support.ts';

export { REFERENCE, TZ, TODAY, TOMORROW, at, currentStorage, show };
export type { Raw };

export const YESTERDAY = '2026-10-06';
const BASE = 'http://localhost:3000';

const ENV_KEYS = [
  'MAYBESITTER_FEATURE_MEMORY_LEARNING',
  'MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING',
  'MAYBESITTER_FEATURE_MEMORY',
  'MAYBESITTER_KILL_SWITCH_MEMORY',
  'MAYBESITTER_FEATURE_RECOMMENDATION',
  'MAYBESITTER_KILL_SWITCH_RECOMMENDATION',
  'MAYBESITTER_AI_DISABLED',
  'MAYBESITTER_LLM_PROVIDER',
  'MAYBESITTER_ENV',
  'MAYBESITTER_NEXT_STEP_ARM',
  'MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS',
] as const;
let saved: Record<string, string | undefined> | null = null;

export interface M5bSwitches {
  /** MAYBESITTER_FEATURE_MEMORY_LEARNING (default on). `null` leaves it unset, as on a deploy that never set it. */
  on?: boolean | null;
  /** MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING (default off). */
  killed?: boolean;
  /** The memory module (default on). */
  memory?: boolean;
  /** MAYBESITTER_AI_DISABLED (default false). */
  aiDisabled?: boolean;
  /** MAYBESITTER_ENV (default 'staging'). */
  environment?: string;
}

/** Sets (or flips, mid-test) the M5b switch and its neighbours. */
export function setM5bSwitches(switches: M5bSwitches = {}): void {
  if (saved === null) saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  if (switches.on === null) delete process.env.MAYBESITTER_FEATURE_MEMORY_LEARNING;
  else process.env.MAYBESITTER_FEATURE_MEMORY_LEARNING = (switches.on ?? true) ? 'true' : 'false';
  if (switches.on === null && !switches.killed) delete process.env.MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING;
  else process.env.MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING = switches.killed ? 'true' : 'false';
  process.env.MAYBESITTER_FEATURE_MEMORY = (switches.memory ?? true) ? 'true' : 'false';
  process.env.MAYBESITTER_KILL_SWITCH_MEMORY = 'false';
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  if (switches.aiDisabled) process.env.MAYBESITTER_AI_DISABLED = 'true';
  else delete process.env.MAYBESITTER_AI_DISABLED;
  delete process.env.MAYBESITTER_LLM_PROVIDER;
  // The baseline arm, not an experiment: the lighter rule runs outside the arms (R4.3).
  delete process.env.MAYBESITTER_NEXT_STEP_ARM;
  delete process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS;
  process.env.MAYBESITTER_ENV = switches.environment ?? 'staging';
}

/** The harness on `staging`, clock at REFERENCE, M5b switches set, an account document with a zone and locale. */
export async function begin(switches: M5bSwitches = {}, account: { timezone?: string; locale?: string } = {}): Promise<string> {
  const uid = beginM4b({ environment: switches.environment ?? 'staging' });
  setM5bSwitches(switches);
  resetMobilePilotDecisionReplaysForTests();
  await setAccount(uid, { timezone: account.timezone ?? TZ, locale: account.locale ?? 'en' });
  // The trust record authentication writes on a uid's first request: every
  // user-content writer refuses a root without one (#772, Q772-001).
  await seedLiveAccount(uid, currentStorage());
  return uid;
}

export function end(): void {
  installedSeam?.(null);
  installedSeam = null;
  if (saved) {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    saved = null;
  }
  endM4b();
}

export async function setAccount(uid: string, fields: Record<string, unknown>): Promise<void> {
  const storage = currentStorage();
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), ...fields });
}

/* ── clock ──────────────────────────────────────────────────────────── */

export const NOW = () => new Date().toISOString();
export function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}
export function plusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
/** Moves the pinned process clock (Date only, unless a test enabled more). */
export function setClock(iso: string): void {
  mock.timers.setTime(Date.parse(iso));
}

/* ── modules the build creates (imported by a computed specifier, so typecheck passes before they exist) ── */

export async function loadModule(repoPath: string): Promise<Record<string, unknown>> {
  const specifier = new URL(`../../../${repoPath}`, import.meta.url).href;
  try {
    return await import(specifier) as Record<string, unknown>;
  } catch (error) {
    assert.fail(`${repoPath} not built (${(error as Error).message.split('\n')[0]})`);
  }
}

/* ── routes ─────────────────────────────────────────────────────────── */

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function route(path: string, method: string): Promise<Handler> {
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

/** Any route, in-process, as `uid`. `signal` is the incoming request's own signal. */
export async function call(
  uid: string,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  options: { params?: Record<string, string>; body?: unknown; query?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Raw> {
  const params = options.params ?? {};
  const concrete = Object.entries(params).reduce((p, [key, value]) => p.replace(`[${key}]`, value), path);
  const handler = await route(path, method);
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const search = options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
  const response = await handler(
    new Request(`${BASE}/api/mobile/${concrete}${search}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    { params: Promise.resolve(params) },
  );
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* left as text */ }
  return { status: response.status, body };
}

export async function probe(uid: string): Promise<any> {
  const result = await call(uid, 'capabilities/m5b', 'GET');
  assert.equal(result.status, 200, show(result.body));
  return result.body;
}

/* ── commitments (the domain's own commands) ────────────────────────── */

let seq = 0;
/** A fresh commitment id. Ids grow with creation order, so an earlier one wins a fully tied ranking. */
export function nextId(): string {
  seq += 1;
  return `0c0ffee6-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

/** A confirmed commitment with an arbitrary `timeSpec`. */
export async function addCommitment(uid: string, title: string, timeSpec: Record<string, unknown>, id: string = nextId()): Promise<string> {
  const now = NOW();
  await applyParticipantCommands(uid, [
    { type: 'CreateDraft', now, commitment: { id, kind: 'task', title, timeSpec: { timezone: TZ, remindAt: null, ...timeSpec } } } as any,
    { type: 'ConfirmCommitment', commitmentId: id, now } as any,
  ]);
  return id;
}

/** A floating task (no time): the planner places it. */
export function addFloating(uid: string, title: string, id?: string): Promise<string> {
  return addCommitment(uid, title, { kind: 'due_by', dueAt: null, allDay: false }, id);
}

export async function editCommitment(uid: string, id: string, updates: Record<string, unknown>): Promise<void> {
  await applyParticipantCommands(uid, [{ type: 'UpdateCommitment', commitmentId: id, now: NOW(), updates } as any]);
}

export async function commitment(uid: string, id: string): Promise<any> {
  const state = await readParticipantState(uid);
  return (state.commitments as Record<string, any>)[id];
}

/* ── readings ───────────────────────────────────────────────────────── */

export type Band = 'low' | 'steady' | 'high';

/** A minimized native health snapshot, as the phone sends it. */
export function healthSnapshot(uid: string, band: Band, computedAt: string): ReadinessSnapshot {
  const score = band === 'low' ? 0.2 : band === 'steady' ? 0.5 : 0.8;
  return {
    version: READINESS_CONTRACT_VERSION,
    schemaVersion: READINESS_SCHEMA_VERSION,
    scopeId: uid,
    computedAt,
    windowStart: plusMinutes(computedAt, -8 * 60),
    windowEnd: computedAt,
    band,
    score,
    normalizedSignals: {},
    subjective: null,
    derived: { readinessBand: band, confidence: 0.8 },
    signals: [{
      signalId: 'healthkit-summary',
      source: { kind: 'healthkit' },
      metric: 'recovery',
      observedAt: computedAt,
      normalizedScore: score,
      nativeValue: null,
      nativeUnit: 'milliseconds',
      confidence: 0.8,
    }],
    sourceKinds: ['healthkit'],
    missingSourceKinds: ['health_connect', 'whoop', 'subjective'],
  } as unknown as ReadinessSnapshot;
}

/**
 * Writes `users/{uid}.readinessContext` exactly as stored, bypassing every
 * write-time check: how a reading written before M5b (or off-mode) looks.
 */
export async function storeReadingContext(uid: string, context: {
  currentSubjective?: { energy: number; observedAt: string } | null;
  recentReadiness?: ReadinessSnapshot | null;
  historicalInference?: ReadinessSnapshot | null;
}): Promise<void> {
  await setAccount(uid, {
    readinessContext: {
      schemaVersion: READINESS_CONTEXT_SCHEMA_VERSION,
      currentSubjective: context.currentSubjective ?? null,
      recentReadiness: context.recentReadiness ?? null,
      historicalInference: context.historicalInference ?? null,
      updatedAt: NOW(),
    },
  });
}

/** A check-in through the real route (PUT /readiness). */
export async function checkIn(uid: string, energy: number, observedAt: string = NOW()): Promise<Raw> {
  return call(uid, 'readiness', 'PUT', { body: { energy, observedAt } });
}

export async function checkInOk(uid: string, energy: number, observedAt: string = NOW()): Promise<string> {
  const saved = await checkIn(uid, energy, observedAt);
  assert.equal(saved.status, 200, `the check-in was refused: ${show(saved.body)}`);
  return observedAt;
}

/** A health snapshot through the real route (POST /readiness). */
export async function postHealth(uid: string, band: Band, computedAt: string): Promise<Raw> {
  return call(uid, 'readiness', 'POST', { body: { snapshot: healthSnapshot(uid, band, computedAt) } });
}

export const NO_READINESS_APPLIED = Object.freeze({ source: 'none', energy: null, band: null, bufferMinutesAdded: 0, observedAt: null });

/* ── plans ──────────────────────────────────────────────────────────── */

export async function buildPlan(uid: string, date: string = TODAY): Promise<any> {
  const built = await call(uid, 'plans/[date]/build', 'POST', { params: { date } });
  assert.equal(built.status, 200, `build answered ${built.status}: ${show(built.body)}`);
  return built.body.plan;
}

export async function getPlan(uid: string, date: string = TODAY): Promise<any> {
  const read = await call(uid, 'plans/[date]', 'GET', { params: { date } });
  assert.equal(read.status, 200, `plan GET answered ${read.status}: ${show(read.body)}`);
  return read.body;
}

export async function planAction(uid: string, body: Record<string, unknown>, date: string = TODAY): Promise<Raw> {
  return call(uid, 'plans/[date]/actions', 'POST', { params: { date }, body });
}

/** Touches the plan: removes its last scheduled item (an edit, not an accept). */
export async function touchPlan(uid: string, date: string = TODAY): Promise<void> {
  const stored = await storedPlan(uid, date);
  const last = stored.plan.scheduled[stored.plan.scheduled.length - 1];
  assert.ok(last, 'fixture: the plan places nothing to remove');
  const edited = await planAction(uid, { action: 'edit', removals: [last.itemId] }, date);
  assert.equal(edited.status, 200, `edit answered ${edited.status}: ${show(edited.body)}`);
}

export async function acceptPlanRoute(uid: string, date: string = TODAY): Promise<void> {
  const accepted = await planAction(uid, { action: 'accept' }, date);
  assert.equal(accepted.status, 200, `accept answered ${accepted.status}: ${show(accepted.body)}`);
}

export async function storedPlan(uid: string, date: string = TODAY): Promise<any> {
  const stored = await readStoredPlan(uid, date, currentStorage());
  assert.ok(stored, `no stored plan for ${date}`);
  return stored as StoredDailyPlan & Record<string, any>;
}

export function buffersOf(stored: any): number[] {
  return (stored.constraints.items as Array<{ bufferAfterMinutes?: number }>).map((item) => item.bufferAfterMinutes ?? 0);
}

/** Removes the M5b fields from a stored plan in place (the "same document, on-mode fields removed" comparison). */
export async function stripOnModeFields(uid: string, date: string = TODAY): Promise<void> {
  const stored = await storedPlan(uid, date);
  const { readinessApplied: _ra, ...rest } = stored as Record<string, any>;
  const next: Record<string, any> = { ...rest };
  if (next.proposal && typeof next.proposal === 'object') {
    const { basisSnapshot: _bs, ...proposal } = next.proposal;
    next.proposal = proposal;
  }
  await currentStorage().set(planPath(uid, date), next);
}

/** Three floating tasks: enough for a plan with buffers between items. */
export async function threeTasks(uid: string, prefix = 'Task'): Promise<string[]> {
  return [
    await addFloating(uid, `${prefix} write the summary`),
    await addFloating(uid, `${prefix} call the bank`),
    await addFloating(uid, `${prefix} book the train`),
  ];
}

/* ── memory rows ────────────────────────────────────────────────────── */

/**
 * Manual memory rows through the real service, one minute apart so the list
 * order is deterministic (newest first). Returns them in `listMemory` order,
 * with the ref PLAN R1.1 assigns: `r1` is the newest.
 */
export async function addRows(uid: string, rows: Array<{ content: string; language?: 'ar' | 'en' | 'he' | 'mixed'; kind?: 'fact' | 'preference' | 'goal' }>): Promise<Array<{ id: string; ref: string; content: string }>> {
  const base = Date.parse(REFERENCE) - (rows.length + 5) * 60_000;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    await createManualMemory(uid, { kind: row.kind ?? 'fact', content: row.content, language: row.language ?? 'en' }, new Date(base + index * 60_000).toISOString());
  }
  const listed = await call(uid, 'memory', 'GET');
  assert.equal(listed.status, 200, show(listed.body));
  return (listed.body.items as Array<{ id: string; content: string }>).map((item, index) => ({ id: item.id, ref: `r${index + 1}`, content: item.content }));
}

/* ── the summary's model (the gate's named seam, for Task B to export) ── */

export interface ModelCall {
  readonly via: 'generateStructured' | 'generateJson';
  readonly request: LlmStructuredRequest | LlmRequest;
}

/**
 * `setMemorySummaryDependenciesForTests(deps: { provider?: LlmProvider } | null)`
 * from `lib/services/mobile/memorySummary.ts` (the module PLAN R1.1 names for
 * the summary). `deps.provider` replaces the configured provider
 * (`getDefaultProvider()`, which production builds as
 * `withSingleRetry(gemini)`) as the provider the summary hands to
 * `consentGatedProvider`. Nothing else is injected: the gates, the usage guard
 * (`reserveCall` / `commitUsage` on the harness storage), the clock and the
 * validation are the real ones. `null` restores the configured provider.
 *
 * The route budget (M5B1-013) must run on the global `setTimeout` / `Date`
 * (not `AbortSignal.timeout`), so `node:test` mock timers can drive it.
 */
async function summarySeam(): Promise<(deps: { provider?: LlmProvider } | null) => void> {
  const module = await loadModule('lib/services/mobile/memorySummary.ts');
  const seam = module.setMemorySummaryDependenciesForTests;
  assert.equal(typeof seam, 'function', 'setMemorySummaryDependenciesForTests is not exported (the gate\'s named seam)');
  return seam as (deps: { provider?: LlmProvider } | null) => void;
}

let installedSeam: ((deps: { provider?: LlmProvider } | null) => void) | null = null;

export async function useSummaryModel(provider: LlmProvider): Promise<void> {
  installedSeam = await summarySeam();
  installedSeam({ provider });
}

/** Every text the model was given in one call, joined (system, user and text parts). */
export function promptOf(request: LlmStructuredRequest | LlmRequest): string {
  const value = request as unknown as Record<string, unknown>;
  const parts = Array.isArray(value.parts) ? (value.parts as Array<{ kind?: string; text?: string }>).filter((part) => typeof part.text === 'string').map((part) => part.text) : [];
  return [value.system, value.user, ...parts].filter((part) => typeof part === 'string').join('\n');
}

/**
 * A scripted model: answers `{ sentences }` (or whatever `answer` returns) and
 * records every call. It is the inner provider; the summary's own
 * `retry: false` / `timeoutMs` reach it unchanged.
 */
export function scriptedModel(answer: (request: LlmStructuredRequest | LlmRequest) => unknown): LlmProvider & { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const respond = (via: ModelCall['via']) => async (request: any): Promise<LlmResponse> => {
    calls.push({ via, request });
    const body = answer(request);
    return { text: typeof body === 'string' ? body : JSON.stringify(body), model: 'fake', latencyMs: 1, promptTokens: 10, outputTokens: 10 };
  };
  return { name: 'gemini', generateJson: respond('generateJson'), generateStructured: respond('generateStructured'), calls } as any;
}

export async function summary(uid: string, language: string = 'en', signal?: AbortSignal): Promise<Raw> {
  return call(uid, 'memory/summary', 'GET', { query: { language }, ...(signal ? { signal } : {}) });
}

/* ── storage snapshots ──────────────────────────────────────────────── */

/** Every live document, by path, as JSON. `exclude` drops paths (usage counters). */
export async function snapshotStorage(exclude: (path: string) => boolean = () => false): Promise<Map<string, string>> {
  const storage = currentStorage() as any;
  const paths: string[] = storage.pathsForTests();
  const out = new Map<string, string>();
  for (const path of paths.sort()) {
    if (exclude(path)) continue;
    out.set(path, JSON.stringify(await storage.get(path)));
  }
  return out;
}

export function isUsagePath(path: string): boolean {
  return /(^|\/)(usage|llmUsage)(\/|$)/.test(path);
}

/** The diff of two snapshots, for an assertion message. */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  after.forEach((value, path) => { if (before.get(path) !== value) changes.push(before.has(path) ? `changed ${path}` : `added ${path}`); });
  before.forEach((_value, path) => { if (!after.has(path)) changes.push(`removed ${path}`); });
  return changes;
}

/* ── next step ──────────────────────────────────────────────────────── */

export async function grantRecommendations(uid: string): Promise<void> {
  await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
}

export async function nextStep(uid: string): Promise<any> {
  const read = await call(uid, 'recommendations/next-step', 'GET', { query: { locale: 'en', timezone: TZ } });
  assert.equal(read.status, 200, `next step answered ${read.status}: ${show(read.body)}`);
  return read.body;
}

export async function decide(uid: string, proposalId: string, decision: string, extra: Record<string, unknown> = {}): Promise<Raw> {
  return call(uid, 'recommendations/next-step/actions', 'POST', {
    body: { proposal: { proposalId }, decision, locale: 'en', timezone: TZ, ...extra },
  });
}

/* ── continuous replan (the real service, as tests/dailyPlan/replanProtectedTime.test.ts drives it) ── */

/** Room for a whole slide, so the policy auto-applies. */
export const AUTO_APPLY = { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 240 } as const;
/** Every replan is an offer. */
export const REVIEW = { userControlMode: 'always_require_confirmation' } as const;

let changeSeq = 0;

/** A calendar meeting over `interval`, written the production way, and the change row that announces it. */
export async function meetingLands(uid: string, interval: { startsAt: string; endsAt: string }, blockId = 'busy-meeting'): Promise<any> {
  const { replaceBusyBlocksAsFixture } = await import('../../support/busyFixtures.ts');
  await replaceBusyBlocksAsFixture(
    uid,
    'device:calendar-m5b',
    { startsAt: at(TODAY, '00:00'), endsAt: at(TOMORROW, '00:00') },
    [{ blockId, sourceId: 'device:calendar-m5b', sourceKind: 'device', startAt: interval.startsAt, endAt: interval.endsAt, allDay: false } as any],
    { storage: currentStorage() as any } as any,
  );
  changeSeq += 1;
  return {
    schemaVersion: 'planning-state-change-v1',
    changeId: `chg-m5b-${changeSeq}`,
    scopeId: uid,
    source: 'calendar',
    entityId: blockId,
    occurredAt: NOW(),
    changedFields: ['interval', 'blocking'],
    beforeDigest: null,
    afterDigest: `digest-${blockId}-${changeSeq}`,
    provenanceRef: `calendar:m5b-${changeSeq}`,
  };
}

/** One replan run over a meeting landing on `interval` (default: the first scheduled item's slot). */
export async function replan(uid: string, policyConfig: Record<string, unknown>, interval?: { startsAt: string; endsAt: string }, blockId?: string): Promise<any> {
  const { processStateChangesForUser } = await import('../../../lib/services/dailyPlan/continuousReplanService.ts');
  const stored = await storedPlan(uid, TODAY);
  const slot = interval ?? stored.plan.scheduled[0]?.interval;
  assert.ok(slot, 'fixture: nothing scheduled for the meeting to land on');
  const change = await meetingLands(uid, slot, blockId);
  return processStateChangesForUser(uid, {
    storage: currentStorage() as any,
    now: new Date(),
    date: TODAY,
    changes: [change],
    entityFactsByChangeId: new Map([[change.changeId, { interval: slot, blocking: true }]]) as any,
    policyConfig: policyConfig as any,
  });
}
