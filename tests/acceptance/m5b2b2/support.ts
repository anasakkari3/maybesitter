/**
 * M5b-2b-2 Gate B, shared harness (PLAN-M5b-2b-2, APPROVED r5: R1 Server and
 * R2 Server, owner decisions 1–4 of 2026-10-22, and every dated review
 * disposition REV-001…005, R2-001…003, R3-001…002, R4-001 are binding).
 * Gate author: Claude, written before the server build. Every test must fail
 * on the base (the M5b-2b-1 integration, PR #781 on M5b-2a #776) for the
 * reason its criterion names, except the parity guards, which pin today's
 * behaviour and pass on the base by design ("parity" in the test title).
 * A negative criterion (no marker, nothing shown) cannot fail on a base that
 * never writes a marker, so each one carries a positive control in the same
 * test, asserted first: the control is what fails on the base.
 *
 * The M5b-2b-1 harness (real routes in-process, fake auth, memory storage,
 * the process clock pinned to REFERENCE = Wednesday 2026-10-07 10:00
 * Asia/Jerusalem, MAYBESITTER_ENV `staging`, the proactive loop on, the
 * recording fake model, personalization and recommendations granted), plus:
 *
 *   - the re-add marker as the plan stores it, in `intelligenceObservations`:
 *     `{ source:'behavior', kind:'outcome', sourceRef:'readd:'+C.id,
 *        evidence:'Re-added', confidence:0.6, review:'pending', reviewedAt:null,
 *        observedAt:C.confirmedAt, linkedMemoryId:null, matchedOutcomeId }`,
 *     id `observationId('behavior', 'readd:'+C.id, { kind:'outcome', evidence:'Re-added' })`;
 *   - the client capability header `X-MaybeSitter-Client-Features: readd`
 *     (REV-005): every on-mode read below sends it unless a test says not;
 *   - commitments dropped, completed and confirmed at chosen instants through
 *     the domain's own commands, so their events are the persisted literals
 *     the state machine writes (R4-001).
 *
 * The scan is driven through `learnOutcomesWhenEnabled` (the entry the routes
 * use) or through the routes themselves, never through a private seam. No test
 * reaches a real model. Copy belongs to the builders: only statuses, reasons,
 * ids, shapes, instants and what is persisted are asserted.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tokenFor } from '../../support/fakeAuth.ts';
import { applyParticipantCommands, readParticipantState } from '../../../lib/services/mobile/participantState.ts';
import { listObservations, observationId, observationPath, putObservations, type StoredObservation } from '../../../lib/intelligence/observationStore.ts';
import { learnFromCommitmentEvents, learnOutcomesWhenEnabled } from '../../../lib/intelligence/outcomeLearning.ts';
import {
  NOW, TZ, currentStorage, ids, nextId, plusMinutes, route, scheduleIds, show, stored, type Raw,
} from '../m5b2b1/support.ts';

export * from '../m5b2b1/support.ts';

/* ── names the build defines (computed specifiers: typecheck passes before they exist) ── */

/** (new — builder defines) The module holding `projectReadd`. */
export const READD_MODULE = 'lib/intelligence/readd.ts';
/** The plan's transactional writer; (new — builder defines) its module. */
export const READD_WRITER_MODULE = 'lib/intelligence/observationStore.ts';

/* ── time ───────────────────────────────────────────────────────────── */

export const DAY_MS = 24 * 60 * 60 * 1000;
export function minusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) - ms).toISOString();
}
export function daysAgo(days: number, from: string = NOW()): string {
  return minusMs(from, days * DAY_MS);
}

/* ── the header ─────────────────────────────────────────────────────── */

export const READD_HEADER = { 'X-MaybeSitter-Client-Features': 'readd' } as const;

const BASE = 'http://localhost:3000';

/** Any route, in-process, as `uid`, with extra request headers. */
export async function callWith(
  uid: string,
  path: string,
  method: 'GET' | 'POST',
  options: { params?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Raw> {
  const params = options.params ?? {};
  const concrete = Object.entries(params).reduce((p, [key, value]) => p.replace(`[${key}]`, value), path);
  const handler = await route(path, method);
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}`, ...(options.headers ?? {}) });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await handler(
    new Request(`${BASE}/api/mobile/${concrete}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    { params: Promise.resolve(params) },
  );
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* left as text */ }
  return { status: response.status, body };
}

const headersFor = (withHeader: boolean) => (withHeader ? { ...READD_HEADER } : {});

export async function inboxH(uid: string, withHeader = true): Promise<any> {
  const result = await callWith(uid, 'intelligence', 'GET', { headers: headersFor(withHeader) });
  assert.equal(result.status, 200, show(result.body));
  return result.body;
}

export async function generateH(uid: string, options: { visit?: boolean; header?: boolean } = {}): Promise<any> {
  const result = await callWith(uid, 'intelligence/generate', 'POST', {
    body: options.visit ? { trigger: 'visit' } : {},
    headers: headersFor(options.header ?? true),
  });
  assert.equal(result.status, 200, show(result.body));
  return result.body;
}

export function decideH(uid: string, id: string, decision: 'accept' | 'dismiss', withHeader = true): Promise<Raw> {
  return callWith(uid, 'intelligence/suggestions/[id]', 'POST', { params: { id }, body: { decision }, headers: headersFor(withHeader) });
}

export function answerH(uid: string, id: string, withHeader = true, text = 'Mornings work best for me'): Promise<Raw> {
  return callWith(uid, 'intelligence/suggestions/[id]/answer', 'POST', { params: { id }, body: { answer: text }, headers: headersFor(withHeader) });
}

export function reviewH(uid: string, id: string, review: 'confirmed' | 'dismissed', withHeader = true): Promise<Raw> {
  return callWith(uid, 'intelligence/observations/[id]', 'POST', { params: { id }, body: { review }, headers: headersFor(withHeader) });
}

/* ── commitments at chosen instants (the domain's own commands) ─────── */

const FLOATING = { timezone: TZ, remindAt: null, kind: 'due_by', dueAt: null, allDay: false };

/** A commitment confirmed at `at` (its `confirmedAt`). */
export async function confirmAt(uid: string, title: string, at: string, id: string = nextId()): Promise<string> {
  await applyParticipantCommands(uid, [
    { type: 'CreateDraft', now: at, commitment: { id, kind: 'task', title, timeSpec: { ...FLOATING } } } as any,
    { type: 'ConfirmCommitment', commitmentId: id, now: at } as any,
  ]);
  return id;
}

/** A commitment confirmed a minute before `at` and dropped at `at` (event `commitment_dropped` at `at`). */
export async function dropAt(uid: string, title: string, at: string, id: string = nextId()): Promise<string> {
  await applyParticipantCommands(uid, [
    { type: 'CreateDraft', now: plusMinutes(at, -1), commitment: { id, kind: 'task', title, timeSpec: { ...FLOATING } } } as any,
    { type: 'ConfirmCommitment', commitmentId: id, now: plusMinutes(at, -1) } as any,
    { type: 'Drop', commitmentId: id, now: at } as any,
  ]);
  return id;
}

/** A commitment confirmed a minute before `at` and completed at `at` (event `commitment_completed` at `at`). */
export async function completeAt(uid: string, title: string, at: string, id: string = nextId()): Promise<string> {
  await applyParticipantCommands(uid, [
    { type: 'CreateDraft', now: plusMinutes(at, -1), commitment: { id, kind: 'task', title, timeSpec: { ...FLOATING } } } as any,
    { type: 'ConfirmCommitment', commitmentId: id, now: plusMinutes(at, -1) } as any,
    { type: 'Complete', commitmentId: id, now: at } as any,
  ]);
  return id;
}

export async function renameCommitment(uid: string, id: string, title: string): Promise<void> {
  await applyParticipantCommands(uid, [{ type: 'UpdateCommitment', commitmentId: id, now: NOW(), updates: { title } } as any]);
}

export async function currentTitle(uid: string, id: string): Promise<string> {
  const state = await readParticipantState(uid);
  const commitment = (state.commitments as Record<string, any>)[id];
  assert.ok(commitment, `fixture: commitment ${id} is gone`);
  return commitment.title;
}

export async function confirmedAtOf(uid: string, id: string): Promise<string> {
  const state = await readParticipantState(uid);
  const at = (state.commitments as Record<string, any>)[id]?.confirmedAt;
  assert.equal(typeof at, 'string', `fixture: commitment ${id} was never confirmed`);
  return at;
}

/* ── events ─────────────────────────────────────────────────────────── */

export function eventsCol(uid: string): string {
  return `users/${uid}/events`;
}

/** The stored event the state machine wrote for `aggregateId` with `type`. */
export async function eventFor(uid: string, aggregateId: string, type: string): Promise<any> {
  const rows = await currentStorage().list<any>(eventsCol(uid));
  const found = rows.map((row) => row.data).filter((event) => event.aggregateId === aggregateId && event.type === type);
  assert.equal(found.length, 1, `fixture: expected one ${type} event for ${aggregateId}, found ${found.length}`);
  return found[0];
}

/** `count` newer non-outcome events, written as stored events are (REV-003's "more than 100 newer"). */
export async function floodEvents(uid: string, count: number, after: string): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = `f100d000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const at = new Date(Date.parse(after) + (index + 1) * 1000).toISOString();
    await currentStorage().set(`${eventsCol(uid)}/${id}`, { id, type: 'commitment_aware', at, aggregateId: 'flood', payload: {}, recordedAt: at });
  }
}

/* ── outcomes and the scan ──────────────────────────────────────────── */

/** Outcome learning as it runs today (the base function), so the dropped/completed rows exist. */
export async function learn(uid: string): Promise<StoredObservation[]> {
  return learnFromCommitmentEvents(uid, currentStorage() as any);
}

/** One scan through the entry every route uses (the outcome pass, then the re-add pass when on). */
export async function scan(uid: string, storage: any = currentStorage()): Promise<void> {
  await learnOutcomesWhenEnabled(uid, storage);
}

/** A behaviour outcome with a chosen event id (as learning writes it: confirmed at write). */
export async function putOutcome(uid: string, eventId: string, evidence: string, observedAt: string): Promise<StoredObservation> {
  const [stored] = await putObservations(uid, 'behavior', eventId, observedAt, [{ kind: 'outcome', evidence, confidence: 1 } as any], currentStorage() as any);
  assert.ok(stored, 'fixture: the outcome was not written');
  return stored;
}

/** The learned outcome for one commitment's event. */
export async function outcomeFor(uid: string, aggregateId: string, type: 'commitment_dropped' | 'commitment_completed'): Promise<StoredObservation> {
  const event = await eventFor(uid, aggregateId, type);
  const found = (await listObservations(uid, currentStorage() as any)).find((row) => row.source === 'behavior' && row.sourceRef === event.id);
  assert.ok(found, `fixture: no outcome was learned for ${aggregateId}`);
  return found;
}

export async function dismissDirectly(uid: string, id: string): Promise<void> {
  const path = observationPath(uid, id);
  const row = await currentStorage().get<StoredObservation>(path);
  assert.ok(row, 'fixture: no such observation');
  await currentStorage().set(path, { ...row, review: 'dismissed', reviewedAt: NOW() });
}

/* ── markers ────────────────────────────────────────────────────────── */

export const MARKER_KEYS = [
  'id', 'source', 'kind', 'sourceRef', 'evidence', 'confidence', 'review', 'reviewedAt', 'observedAt', 'linkedMemoryId', 'matchedOutcomeId',
] as const;

export function markerId(commitmentId: string): string {
  return observationId('behavior', `readd:${commitmentId}`, { kind: 'outcome', evidence: 'Re-added', confidence: 0.6 } as any);
}

export function isMarker(row: { sourceRef?: unknown } | null | undefined): boolean {
  return typeof row?.sourceRef === 'string' && row.sourceRef.startsWith('readd:');
}

/** Every stored re-add marker. */
export async function markers(uid: string): Promise<any[]> {
  return (await listObservations(uid, currentStorage() as any)).filter(isMarker);
}

/** The stored markers for commitment `commitmentId` (one at most, by the plan). */
export async function markersFor(uid: string, commitmentId: string): Promise<any[]> {
  return (await markers(uid)).filter((row) => row.sourceRef === `readd:${commitmentId}`);
}

/** The one marker for `commitmentId`, failing with `what` when the scan wrote none. */
export async function markerFor(uid: string, commitmentId: string, what = 'the scan wrote no re-add marker'): Promise<any> {
  const found = await markersFor(uid, commitmentId);
  assert.equal(found.length, 1, `${what} (found ${found.length} for readd:${commitmentId})`);
  return found[0];
}

/** A marker written straight to storage in the plan's shape (off/killed fixtures, which no scan writes). */
export async function seedMarker(
  uid: string,
  commitmentId: string,
  matchedOutcomeId: string,
  observedAt: string,
  review: 'pending' | 'confirmed' | 'dismissed' = 'pending',
): Promise<any> {
  const id = markerId(commitmentId);
  const marker = {
    id, source: 'behavior', kind: 'outcome', sourceRef: `readd:${commitmentId}`, evidence: 'Re-added', confidence: 0.6,
    review, reviewedAt: review === 'pending' ? null : NOW(), observedAt, linkedMemoryId: null, matchedOutcomeId,
  };
  await currentStorage().set(observationPath(uid, id), marker);
  return marker;
}

/** The inbox row for one marker id (undefined when left out). */
export function inboxRow(body: any, id: string): any {
  return (body?.observations ?? []).find((row: any) => row.id === id);
}

/** Every object in a JSON value, depth first. */
export function objects(value: unknown, out: Array<Record<string, any>> = []): Array<Record<string, any>> {
  if (Array.isArray(value)) for (const item of value) objects(item, out);
  else if (value && typeof value === 'object') {
    out.push(value as Record<string, any>);
    for (const item of Object.values(value)) objects(item, out);
  }
  return out;
}

/** No object anywhere carries `signal: 'readded'` (the shipped closed enum must never see it). */
export function assertNoReaddedSignal(body: unknown, what: string): void {
  for (const row of objects(body)) assert.notEqual(row.signal, 'readded', `${what}: a 'readded' signal was sent: ${show(row)}`);
}

/* ── the fixture most tests share ───────────────────────────────────── */

/**
 * A dropped D «title» learned as an outcome two days ago, then C «title»
 * confirmed an hour ago. Returns the ids; the marker does not exist until a scan.
 */
export async function droppedThenReadded(uid: string, title: string, options: { droppedAt?: string; confirmedAt?: string; verb?: 'dropped' | 'completed' } = {}) {
  const droppedAt = options.droppedAt ?? daysAgo(2);
  const confirmedAt = options.confirmedAt ?? plusMinutes(NOW(), -60);
  const verb = options.verb ?? 'dropped';
  const d = verb === 'dropped' ? await dropAt(uid, title, droppedAt) : await completeAt(uid, title, droppedAt);
  await learn(uid);
  const outcome = await outcomeFor(uid, d, verb === 'dropped' ? 'commitment_dropped' : 'commitment_completed');
  const c = await confirmAt(uid, title, confirmedAt);
  return { d, c, outcome, confirmedAt };
}

/* ── claims and reads of suggestions citing a re-add ───────────────── */

export type ClaimKind = 'action' | 'goal' | 'warning' | 'question';
export const CLAIM_KINDS: readonly ClaimKind[] = ['action', 'goal', 'warning', 'question'];

/** Every claim path refuses: nothing accepted, no commitment, no answer recorded. */
export async function assertAllClaimsRefused(uid: string, rows: Record<ClaimKind, any>, withHeader: boolean, what: string): Promise<void> {
  const commitments = Object.keys((await readParticipantState(uid)).commitments).length;
  for (const kind of ['action', 'goal', 'warning'] as const) {
    const result = await decideH(uid, rows[kind].id, 'accept', withHeader);
    assert.ok(result.status < 500, `${what}: accepting a ${kind} answered ${result.status} ${show(result.body)}`);
    const after = await stored(uid, rows[kind].id);
    assert.notEqual(after?.status, 'accepted', `${what}: a ${kind} citing the re-add was accepted`);
    assert.equal(after?.linkedEntityId ?? null, null, `${what}: a ${kind} citing the re-add created ${after?.linkedEntityId}`);
  }
  assert.equal(Object.keys((await readParticipantState(uid)).commitments).length, commitments, `${what}: an accept created a commitment`);
  const observations = (await listObservations(uid, currentStorage() as any)).length;
  const answered = await answerH(uid, rows.question.id, withHeader);
  assert.ok(answered.status < 500, `${what}: answering answered ${answered.status} ${show(answered.body)}`);
  const question = await stored(uid, rows.question.id);
  assert.notEqual(question?.status, 'accepted', `${what}: the question citing the re-add was answered`);
  assert.equal(question?.answerDigest, undefined, `${what}: an answer was recorded`);
  assert.equal((await listObservations(uid, currentStorage() as any)).length, observations, `${what}: answer evidence was recorded`);
}

export function assertHidden(body: any, rows: Record<ClaimKind, any>, what: string): void {
  const shown = ids(body.suggestions);
  for (const kind of CLAIM_KINDS) assert.equal(shown.includes(rows[kind].id), false, `${what}: a ${kind} citing the re-add is shown`);
  for (const kind of CLAIM_KINDS) assert.equal(scheduleIds(body).includes(rows[kind].id), false, `${what}: a schedule row names a ${kind} citing the re-add`);
}

/* ── determinism ────────────────────────────────────────────────────── */

/**
 * Replaces every 64-hex id and every uuid by its order of first appearance,
 * so bytes that carry ids derived from a random event uuid digest stably.
 * Only call on text whose order is fixed by stable content (distinct instants).
 */
export function normaliseIds(text: string): string {
  const seen = new Map<string, string>();
  return text.replace(/[a-f0-9]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match) => {
    if (!seen.has(match)) seen.set(match, `ID${seen.size}`);
    return seen.get(match)!;
  });
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
