/**
 * M5b-2b-1 Gate B, shared harness (PLAN-M5b-2b-1, APPROVED at r20; R1 Server
 * and R2 Server with every R*-numbered disposition are binding). Gate author:
 * Claude, written before the server build. Every test must fail on the base
 * (the M5b-2a landing, PR #776) for the reason its criterion names, except the
 * parity guards, which pin today's behaviour and pass on the base by design
 * ("parity" in the test title).
 *
 * The M5b-2a harness (real routes in-process, fake auth, memory storage, the
 * clock pinned to REFERENCE, the proactive loop on), plus:
 *
 *   - a fake model, installed through the engine's own test seam
 *     (`setIntelligenceGeneratorForTests`), that records every request and
 *     answers with chosen JSON. No test reaches a real model;
 *   - the three M5b modes by their switches: `on_basis` (memory learning on,
 *     memory module on), `on_nobasis` (memory learning on, memory module off:
 *     the kill switch REV-003 names) and `off` (memory learning off);
 *   - the stored shapes the plan names: `memoryBasis: { memoryIds, epoch }`
 *     and `mode` on a suggestion and on a run, and
 *     `users/{uid}/memoryCitations/{memoryId}__{suggestionId}`.
 *
 * Copy belongs to the builders: only statuses, error codes, ids, shapes,
 * instants and what is persisted are asserted.
 */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  intelligenceRunPath,
  setIntelligenceGeneratorForTests,
  suggestionPath,
  type IntelligenceRun,
  type IntelligenceSuggestion,
} from '../../../lib/intelligence/proposalEngine.ts';
import { putObservations, observationId, type StoredObservation } from '../../../lib/intelligence/observationStore.ts';
import { createStorageRuntimeMemoryStore, runtimeMemoryRecordPath } from '../../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { BEGIN_UNTRUSTED_SHARED_CONTENT, END_UNTRUSTED_SHARED_CONTENT } from '../../../lib/services/share/shareTypes.ts';
import { userDoc } from '../../../lib/storage/paths.ts';
import { setStorageForTests } from '../../../lib/storage/index.ts';
import type { ShareStructuredGenerator } from '../../../lib/llm/shareProvider.ts';
import {
  NOW,
  begin as begin2a,
  call,
  currentStorage,
  end as end2a,
  grantPersonalization,
  grantRecommendations,
  setAccount,
  setM5bSwitches,
  show,
} from '../m5b2a/support.ts';

export * from '../m5b2a/support.ts';

/* ── modes ──────────────────────────────────────────────────────────── */

export type Mode = 'on_basis' | 'on_nobasis' | 'off';

/** Flips the switches to one M5b mode (mid-test too). */
export function setMode(mode: Mode): void {
  if (mode === 'on_basis') setM5bSwitches({});
  else if (mode === 'on_nobasis') setM5bSwitches({ memory: false });
  else setM5bSwitches({ on: false });
}

/**
 * The harness in `on_basis` (memory rows are created through the memory
 * module, which must be on), personalization and recommendations granted,
 * the fake model installed. A test seeds, then calls `setMode` for its mode.
 */
export async function begin(): Promise<string> {
  const uid = await begin2a();
  await grantPersonalization(uid);
  await grantRecommendations(uid);
  model.reset();
  setIntelligenceGeneratorForTests(model.generate);
  return uid;
}

export function end(): void {
  setIntelligenceGeneratorForTests(null);
  model.reset();
  end2a();
}

/* ── the fake model ─────────────────────────────────────────────────── */

export interface ModelCall {
  readonly index: number;
  readonly system: string;
  /** The parsed JSON between the untrusted-content markers. */
  readonly context: any;
  readonly responseSchema: any;
  /** The whole request, serialized: what "the bytes sent to the model" means here. */
  readonly raw: string;
}

type Reply = (call: ModelCall) => unknown | Promise<unknown>;

function parseContext(request: { parts: readonly any[] }): any {
  const text = request.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
  const start = text.indexOf(BEGIN_UNTRUSTED_SHARED_CONTENT);
  const stop = text.indexOf(END_UNTRUSTED_SHARED_CONTENT);
  if (start < 0 || stop < 0) return null;
  return JSON.parse(text.slice(start + BEGIN_UNTRUSTED_SHARED_CONTENT.length, stop));
}

export const model = {
  calls: [] as ModelCall[],
  replies: [] as Reply[],
  /** Runs inside the model call, before the reply: where a test moves the world. */
  during: null as ((call: ModelCall) => void | Promise<void>) | null,
  reset(): void {
    this.calls = [];
    this.replies = [];
    this.during = null;
  },
  /** Answers call N with `replies[N]`; any later call answers `{ suggestions: [] }`. */
  answer(...replies: Reply[]): void {
    this.replies = replies;
  },
  generate: (async (request) => {
    const call: ModelCall = {
      index: model.calls.length,
      system: String(request.system ?? ''),
      context: parseContext(request as any),
      responseSchema: request.responseSchema,
      raw: JSON.stringify(request),
    };
    model.calls.push(call);
    if (model.during) await model.during(call);
    const reply = model.replies[call.index];
    const body = reply ? await reply(call) : { suggestions: [] };
    return { text: JSON.stringify(body), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
  }) as ShareStructuredGenerator,
};

/** One suggestion as the model writes it. */
export function said(
  kind: 'goal' | 'action' | 'question' | 'warning',
  title: string,
  observationIds: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind,
    title,
    reason: 'Because of what you told me before',
    observationIds,
    confidence: 0.8,
    durationMinutes: kind === 'action' ? 30 : 0,
    ...extra,
  };
}

/** The identity hash `validateSuggestions` gives a suggestion (memory is not part of it). */
export function identityOf(kind: string, title: string, observationIds: string[]): string {
  return createHash('sha256').update([kind, title.trim().toLowerCase(), ...Array.from(new Set(observationIds))].join('\0')).digest('hex');
}

/** The memory entries one model call was given (empty when none). */
export function memoryEntries(call: ModelCall): any[] {
  const memory = call.context?.memory;
  return Array.isArray(memory) ? memory : [];
}

/** The alias (`m1`…) the model saw for the memory whose content is `content`, from the request itself. */
export function aliasFor(call: ModelCall, content: string): string {
  const entry = memoryEntries(call).find((item) => item.content === content);
  assert.ok(entry, `the model was not given the memory «${content}»`);
  const alias = Object.values(entry).find((value) => typeof value === 'string' && /^m\d{1,2}$/.test(value));
  assert.ok(alias, `the memory «${content}» was sent without an alias (m1…m30): ${show(entry)}`);
  return alias as string;
}

/** `aliasFor` inside a model reply: never throws (a throw there is swallowed by the engine as a model failure). */
export function aliasOf(call: ModelCall, content: string): string {
  try { return aliasFor(call, content); } catch { return 'unaliased'; }
}

/** The ids of every observation one model call was given. */
export function observationIdsSent(call: ModelCall): string[] {
  const observations = call.context?.observations;
  return Array.isArray(observations) ? observations.map((item: any) => item.id) : [];
}

/** The schema's per-suggestion properties as the model received them. */
export function suggestionSchemaProperties(call: ModelCall): Record<string, any> {
  const items = call.responseSchema?.properties?.suggestions?.items;
  assert.ok(items?.properties, `no suggestion item schema in the request: ${show(call.responseSchema)}`);
  return items.properties as Record<string, any>;
}

/* ── observations and memory ────────────────────────────────────────── */

let manualSeq = 0;
/** A pending manual observation (a statement), the plain evidence most suggestions cite. */
export async function statement(uid: string, evidence: string, kind: string = 'intention'): Promise<StoredObservation> {
  manualSeq += 1;
  const [stored] = await putObservations(uid, 'manual', `gate-b-manual-${manualSeq}`, NOW(), [{ kind, evidence, confidence: 0.8 } as any], currentStorage() as any);
  return stored!;
}

/** The id the canonical sync gives the observation copy of a goal memory. */
export function memoryObservationId(memoryId: string, content: string, confidence = 1): string {
  return observationId('memory', memoryId, { kind: 'goal', evidence: content, confidence } as any);
}

/** Every stored observation whose source is `memory`. */
export async function memoryObservations(uid: string): Promise<StoredObservation[]> {
  const rows = await currentStorage().list<StoredObservation>(`users/${uid}/intelligenceObservations`);
  return rows.map((row) => row.data).filter((row) => row.source === 'memory');
}

/** A memory record written straight to the store, with an optional short life (R8-002). */
export async function putMemory(uid: string, content: string, options: { kind?: 'fact' | 'preference' | 'goal'; ttlMs?: number } = {}): Promise<string> {
  const record = await createStorageRuntimeMemoryStore(undefined, currentStorage() as any).put({
    scopeId: uid,
    kind: options.kind ?? 'fact',
    content,
    language: 'en',
    source: 'user_stated',
    confidence: 1,
    observedAt: NOW(),
    ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
    evidenceIds: [],
    provenance: { origin: 'manual' },
  } as any, NOW());
  return record.id;
}

/** Revokes a record (it stays stored, inactive): residue that cleanup never saw. */
export async function revokeMemory(id: string): Promise<void> {
  assert.equal(await createStorageRuntimeMemoryStore(undefined, currentStorage() as any).revoke(id, NOW()), true, 'fixture: revoke failed');
}

/** Removes a record's document directly, outside any transaction (a delete landing mid-flight). */
export async function removeMemoryRecord(uid: string, id: string): Promise<void> {
  await currentStorage().delete(runtimeMemoryRecordPath(uid, id));
}

/* ── the fence and the account ──────────────────────────────────────── */

export async function epochOf(uid: string): Promise<number> {
  const user = await currentStorage().get<any>(userDoc(uid));
  const epoch = user?.personalizationPurge?.epoch;
  return typeof epoch === 'number' ? epoch : 0;
}

/** Writes the personalization fence directly (not in a transaction: safe from inside one). */
export async function setFence(uid: string, fence: { state: string; epoch: number }): Promise<void> {
  const storage = currentStorage();
  const user = (await storage.get<Record<string, unknown>>(userDoc(uid))) ?? {};
  await storage.set(userDoc(uid), { ...user, personalizationPurge: { ...((user.personalizationPurge as object) ?? {}), ...fence } });
}

/** `markDeleted`, as account deletion writes it (outside any transaction). */
export async function markDeletedNow(uid: string): Promise<void> {
  const storage = currentStorage();
  const user = (await storage.get<Record<string, any>>(userDoc(uid))) ?? {};
  await storage.set(userDoc(uid), { ...user, trust: { ...(user.trust ?? {}), deletedAt: NOW(), updatedAt: NOW() } });
}

/** markDeleted and then the user-tree sweep, both complete. */
export async function sweepAccountNow(uid: string): Promise<void> {
  await markDeletedNow(uid);
  await currentStorage().deleteTree(userDoc(uid));
}

/** Every live path under `users/{uid}` (the document itself included). */
export function userPaths(uid: string): string[] {
  const all: string[] = (currentStorage() as any).pathsForTests();
  return all.filter((path) => path === userDoc(uid) || path.startsWith(`${userDoc(uid)}/`));
}

/* ── suggestions, runs, citations ───────────────────────────────────── */

export function citationPath(uid: string, memoryId: string, suggestionId: string): string {
  return `users/${uid}/memoryCitations/${memoryId}__${suggestionId}`;
}

export function citationPaths(uid: string): string[] {
  const all: string[] = (currentStorage() as any).pathsForTests();
  return all.filter((path) => path.startsWith(`users/${uid}/memoryCitations/`));
}

export async function writeCitation(uid: string, memoryId: string, suggestionId: string): Promise<void> {
  await currentStorage().set(citationPath(uid, memoryId, suggestionId), { memoryId, suggestionId });
}

export async function stored(uid: string, id: string): Promise<any> {
  return currentStorage().get<any>(suggestionPath(uid, id));
}

export async function allStoredSuggestions(uid: string): Promise<any[]> {
  const rows = await currentStorage().list<IntelligenceSuggestion>(`users/${uid}/intelligenceProposals`);
  return rows.map((row) => row.data);
}

export async function latestRun(uid: string): Promise<(IntelligenceRun & Record<string, any>) | null> {
  return currentStorage().get<any>(intelligenceRunPath(uid));
}

export async function writeRun(uid: string, run: Record<string, unknown>): Promise<void> {
  await currentStorage().set(intelligenceRunPath(uid), run);
}

let seeded = 0;
/**
 * A stored suggestion written straight to storage, with any provenance:
 * `mode` absent (legacy/off), 'on_basis' or 'on_nobasis', and an optional
 * `memoryBasis` (the plan's internal marker shape).
 */
export async function seedSuggestion(
  uid: string,
  kind: IntelligenceSuggestion['kind'],
  observationIds: string[],
  provenance: { mode?: 'on_basis' | 'on_nobasis'; memoryIds?: string[]; epoch?: number; citations?: boolean } = {},
  overrides: Record<string, unknown> = {},
): Promise<any> {
  seeded += 1;
  const title = overrides.title as string | undefined
    ?? (kind === 'question' ? `Question ${seeded}: do mornings suit you?` : `Seeded suggestion number ${seeded}`);
  const suggestion: Record<string, unknown> = {
    id: identityOf(kind, title, observationIds),
    kind,
    title,
    reason: 'Because of what you told me before',
    observationIds,
    confidence: 0.7,
    durationMinutes: kind === 'action' ? 30 : null,
    status: 'pending',
    position: seeded,
    decidedAt: null,
    linkedEntityId: null,
    generatedAt: NOW(),
    ...(provenance.mode ? { mode: provenance.mode } : {}),
    ...(provenance.memoryIds ? { memoryBasis: { memoryIds: provenance.memoryIds, epoch: provenance.epoch ?? 0 } } : {}),
    ...overrides,
  };
  await currentStorage().set(suggestionPath(uid, suggestion.id as string), suggestion);
  if (provenance.memoryIds && provenance.citations !== false) {
    for (const memoryId of provenance.memoryIds) await writeCitation(uid, memoryId, suggestion.id as string);
  }
  return suggestion;
}

/* ── routes ─────────────────────────────────────────────────────────── */

export async function inbox(uid: string): Promise<any> {
  const result = await call(uid, 'intelligence', 'GET');
  assert.equal(result.status, 200, show(result.body));
  return result.body;
}

export async function generate(uid: string, visit = false): Promise<any> {
  const result = await call(uid, 'intelligence/generate', 'POST', { body: visit ? { trigger: 'visit' } : {} });
  assert.equal(result.status, 200, show(result.body));
  return result.body;
}

export function decide(uid: string, id: string, decision: 'accept' | 'dismiss') {
  return call(uid, 'intelligence/suggestions/[id]', 'POST', { params: { id }, body: { decision } });
}

export function answer(uid: string, id: string, text = 'Mornings work best for me') {
  return call(uid, 'intelligence/suggestions/[id]/answer', 'POST', { params: { id }, body: { answer: text } });
}

export function exportAccount(uid: string) {
  return call(uid, 'account/export', 'GET');
}

export function deleteMemoryRoute(uid: string, id: string) {
  return call(uid, 'memory/[id]', 'DELETE', { params: { id } });
}

export function patchMemoryRoute(uid: string, id: string, content: string) {
  return call(uid, 'memory/[id]', 'PATCH', { params: { id }, body: { content } });
}

/** The refusal every action gives a hidden suggestion (R12-002, R7-001, R8-002). */
export function assertUnavailable(result: { status: number; body: any }, what: string): void {
  assert.equal(result.status, 404, `${what}: expected 404 suggestion_unavailable, got ${result.status} ${show(result.body)}`);
  assert.equal(result.body?.reason, 'suggestion_unavailable', `${what}: ${show(result.body)}`);
}

export function ids(rows: Array<{ id: string }> | undefined): string[] {
  return (rows ?? []).map((row) => row.id);
}

export function scheduleIds(body: any): string[] {
  return ((body?.schedule ?? []) as Array<{ suggestionId: string }>).map((row) => row.suggestionId);
}

/* ── storage seams ──────────────────────────────────────────────────── */

const MEMORY_PATH = /^users\/[^/]+\/memory(\/|$)/;

export function isMemoryPath(path: unknown): boolean {
  return typeof path === 'string' && MEMORY_PATH.test(path);
}

/**
 * The same storage with every read of the runtime-memory collection failing
 * (`list`/`get` under `users/{uid}/memory`, the `memory` collection group),
 * inside transactions too: the fenced snapshot cannot be read.
 */
export function memoryUnreadable(storage: any): any {
  const failingRead = (key: PropertyKey, path: unknown) =>
    ((key === 'list' || key === 'get') && isMemoryPath(path))
    || (key === 'getMany' && Array.isArray(path) && path.some(isMemoryPath))
    || (key === 'listGroup' && path === 'memory');
  const wrapReader = (target: any) => new Proxy(target, {
    get(inner, key) {
      const value = Reflect.get(inner, key);
      if (typeof value !== 'function') return value;
      if (key === 'list' || key === 'get' || key === 'listGroup' || key === 'getMany') {
        return async (path: unknown, ...rest: unknown[]) => {
          if (failingRead(key, path)) throw new Error('memory unreadable');
          return value.call(inner, path, ...rest);
        };
      }
      if (key === 'runTransaction') {
        return (fn: (tx: any) => Promise<unknown>) => value.call(inner, (tx: any) => fn(wrapReader(tx)));
      }
      return value.bind(inner);
    },
  });
  return wrapReader(storage);
}

/**
 * Wraps the storage so `onTx(tx, path, kind)` sees every write a transaction
 * makes (set/merge/create/delete) and every read, and `onRead`/`onWrite` see
 * the direct calls too. A hook may throw to inject a fault.
 */
export function spyStorage(storage: any, hooks: {
  onRead?: (method: string, path: unknown, options?: any) => void | Promise<void>;
  /** After a read resolved, with its result (a hook here may move the world). */
  afterRead?: (method: string, path: unknown, result: unknown, options?: any) => void | Promise<void>;
  onWrite?: (method: string, path: string, value?: unknown) => void | Promise<void>;
}): any {
  const wrap = (target: any, inTx: boolean): any => new Proxy(target, {
    get(inner, key) {
      const value = Reflect.get(inner, key);
      if (typeof value !== 'function') return value;
      if (key === 'get' || key === 'list' || key === 'listGroup' || key === 'getMany') {
        return async (path: unknown, ...rest: unknown[]) => {
          const method = `${inTx ? 'tx.' : ''}${String(key)}`;
          await hooks.onRead?.(method, path, rest[0]);
          const result = await value.call(inner, path, ...rest);
          await hooks.afterRead?.(method, path, result, rest[0]);
          return result;
        };
      }
      if (key === 'set' || key === 'merge' || key === 'create' || key === 'delete') {
        if (inTx) {
          return (path: string, ...rest: unknown[]) => {
            const hooked = hooks.onWrite?.(`tx.${String(key)}`, path, rest[0]);
            if (hooked && typeof (hooked as Promise<void>).then === 'function') {
              throw new Error('gate harness: a transaction write hook must be synchronous');
            }
            return value.call(inner, path, ...rest);
          };
        }
        return async (path: string, ...rest: unknown[]) => {
          await hooks.onWrite?.(String(key), path, rest[0]);
          return value.call(inner, path, ...rest);
        };
      }
      if (key === 'runTransaction') {
        return (fn: (tx: any) => Promise<unknown>) => value.call(inner, (tx: any) => fn(wrap(tx, true)));
      }
      return value.bind(inner);
    },
  });
  return wrap(storage, false);
}

/** Runs `work` with the global storage swapped for `proxy`, then restores it. */
export async function withStorage<T>(proxy: any, work: () => Promise<T>): Promise<T> {
  const real = currentStorage();
  setStorageForTests(proxy);
  try {
    return await work();
  } finally {
    setStorageForTests(real as any);
  }
}

/** Lets fire-and-forget work (lazy removal) run: several turns of the event loop. */
export async function settle(turns = 30): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

export { setAccount, userDoc };
