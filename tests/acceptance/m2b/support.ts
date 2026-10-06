/**
 * M2b Task B acceptance gate (evidence/claudex-20261006/M2b/PLAN-B.md and
 * CONTRACT.md v1 → v4; v4 wins where they differ), shared harness. Written by
 * the independent acceptance-test writer, not a builder.
 *
 * Every test drives the real routes in-process — `POST /api/mobile/capture/chat`
 * (a message, or a structured `edit`), `/capture/clarify`, `/capture/confirm`
 * and `/api/mobile/seeds` — with fake auth and memory storage: the rules path
 * with no model at all, the model path with a scripted model answer. The
 * reference time is fixed (Wednesday 2026-10-07 10:00, Asia/Jerusalem), never
 * the real clock.
 *
 * Time patches are absolute instants (v4 `change.time: { at, timeZone }`). The
 * contract checks "not in the past by the server clock", so every instant an
 * edit SETS is in January 2030 — in the future for years whichever clock the
 * server reads — and every instant meant to be refused is before the reference.
 *
 * Only what the plan and the contract name is asserted: statuses, reasons,
 * ids kept, revision numbers, turns recorded, and what the confirm persists
 * (read back through the participant state, as the M2a gate does). Copy is the
 * builders' to choose.
 */
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../../support/fakeAuth.ts';
import { POST as chatPost } from '../../../src/app/api/mobile/capture/chat/route.ts';
import { POST as clarifyPost } from '../../../src/app/api/mobile/capture/clarify/route.ts';
import { POST as confirmPost } from '../../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as seedsGet, POST as seedsPost } from '../../../src/app/api/mobile/seeds/route.ts';
import { setCaptureChatDependenciesForTests } from '../../../lib/services/captureChat/captureChatService.ts';
import { claimsSaved } from '../../../lib/services/captureChat/chatReply.ts';
import { getParticipantStateSnapshot } from '../../../lib/services/mobile/participantState.ts';
import { instantFromLocal } from '../../../src/extraction/timeLexicon.ts';
import type { LLMProviderFunction } from '../../../src/extraction/llm/index.ts';

const BASE = 'http://localhost:3000';
export const TZ = 'Asia/Jerusalem';

/** Wednesday 2026-10-07, 10:00 in Jerusalem (UTC+3). Fixed: never the real clock. */
export const REFERENCE = '2026-10-07T07:00:00.000Z';
export const TODAY = '2026-10-07';
/** «بكرا» from the reference. */
export const TOMORROW = '2026-10-08';
/** Thursday 2030-01-10: where every time an edit sets lands (Jerusalem is UTC+2 in January). */
export const LATER = '2030-01-10';
/** Before the reference and before any real clock this gate will run on. */
export const PAST_INSTANT = '2026-10-01T07:00:00.000Z';

export function at(date: string, time: string, zone: string = TZ): string {
  return instantFromLocal(date, time, zone)!.toISOString();
}

/* ── shapes read from the answers ─────────────────────────────────── */

export type Point =
  | { kind: 'commitment'; itemId: string; text: string }
  | { kind: 'possible_goal' | 'consideration' | 'idea' | 'waiting_for'; seedItemId: string; text: string };
export type Correction = { id: string; from: string; to: string };
export type Item = {
  itemId: string;
  title: string;
  resolvedTime: string | null;
  resolvedDate?: string;
  endTime?: string;
  needsClarification: boolean;
  clarification?: {
    questionId: string;
    questionKey?: string;
    options: Array<{ optionId: string; value?: { localTime?: string; localDate?: string } }>;
  } | null;
  conflicts?: unknown[];
  corrections?: Correction[];
};
export type Seed = { seedItemId: string; kind: string; summary: string };
export type Proposal = {
  proposalId: string;
  status: string;
  items: Item[];
  seeds: Seed[];
  understood?: Point[];
  revision?: number;
};
export type Turn = { role: 'user' | 'assistant'; text: string };
export type Answer = {
  conversationId: string;
  reply: string;
  engine: 'model' | 'rules';
  proposal: Proposal | null;
  turns: Turn[];
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Raw = { status: number; body: any };
export type SeedKind = 'possible_goal' | 'consideration' | 'idea' | 'waiting_for';
export type Kind = 'commitment' | SeedKind;
export const SEED_KINDS: readonly SeedKind[] = ['possible_goal', 'consideration', 'idea', 'waiting_for'];

/* ── harness ──────────────────────────────────────────────────────── */

let auth: FakeAuthControls | null = null;
let storage: MemoryStorageAdapter | null = null;
let counter = 0;
let clockOffsetMs = 0;
let modelCallCount = 0;
let modelDown = false;

const clock = () => Date.now() + clockOffsetMs;

function begin(provider: LLMProviderFunction | null, label: string): string {
  auth = installFakeAuth();
  storage = createMemoryStorage();
  setStorageForTests(storage);
  clockOffsetMs = 0;
  modelCallCount = 0;
  modelDown = false;
  // When the model is "down" (the cap reached, the provider failing) it
  // throws, as `captureLlmProvider` does; the chat falls back to the rules.
  const failing: LLMProviderFunction = async () => {
    modelCallCount += 1;
    throw new Error('the model is down for this test');
  };
  setCaptureChatDependenciesForTests({
    llmProviderFor: () => (provider === null ? null : modelDown ? failing : provider),
    clock,
  });
  return uidFor(`${label}${counter++}`);
}

/** The rules path: no model for this account. */
export function beginRules(): string {
  return begin(null, 'AccM2bRules');
}

/** The model path: a scripted model answering `answers` in order (the last one repeats). */
export function beginModel(...answers: unknown[]): string {
  let calls = 0;
  const provider: LLMProviderFunction = async () => {
    modelCallCount += 1;
    return JSON.stringify(answers[Math.min(calls++, answers.length - 1)]);
  };
  return begin(provider, 'AccM2bModel');
}

/** How many times the scripted model was called in this test. */
export function modelCalls(): number {
  return modelCallCount;
}

/** From now on the model throws (a cap reached, a provider down). */
export function takeModelDown(): void {
  modelDown = true;
}

/** Moves the chat service's clock (conversation idle expiry) forward. */
export function advanceClock(ms: number): void {
  clockOffsetMs += ms;
}

/** Another account, signed in through the same fake auth. */
export function otherAccount(): string {
  return uidFor(`AccM2bOther${counter++}`);
}

export function currentStorage(): MemoryStorageAdapter {
  assert.ok(storage, 'no storage: call beginRules/beginModel first');
  return storage!;
}

export function end(): void {
  setCaptureChatDependenciesForTests(null);
  resetStorageForTests();
  auth?.restore();
  auth = null;
  storage = null;
}

function request(path: string, uid: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function raw(response: Response): Promise<Raw> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // left as text: the assertion message shows it
  }
  return { status: response.status, body };
}

export function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text && text.length > 900 ? `${text.slice(0, 900)}…` : String(text);
}

/* ── the chat route ───────────────────────────────────────────────── */

export interface ChatOptions {
  conversationId?: string;
  locale?: 'ar' | 'en' | 'he';
  timezone?: string;
  referenceTime?: string;
  spoken?: boolean;
}

/** Any chat body, as sent: what the route answers, unasserted. */
export async function chatRaw(uid: string, body: Record<string, unknown>): Promise<Raw> {
  return raw(await chatPost(request('/api/mobile/capture/chat', uid, body)));
}

export async function chat(uid: string, message: string, options: ChatOptions = {}): Promise<Answer> {
  const result = await chatRaw(uid, {
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    message,
    ...(options.spoken === undefined ? {} : { spoken: options.spoken }),
    timezone: options.timezone ?? TZ,
    referenceTime: options.referenceTime ?? REFERENCE,
    ...(options.locale ? { locale: options.locale } : {}),
  });
  assert.equal(result.status, 200, `chat answered ${result.status}: ${show(result.body)}`);
  return result.body as Answer;
}

export type Target = { itemId: string } | { seedItemId: string };
export interface Change {
  kind?: Kind;
  text?: string;
  time?: { at: string | null; timeZone: string };
  rejectCorrectionIds?: string[];
}
export interface EditSpec {
  proposalId: string;
  revision: number;
  target: Target;
  change: Change;
}

/** The revision an answer's proposal says it is at (absent reads as 0, the contract's legacy rule). */
export function revisionOf(proposal: Proposal | null | undefined): number {
  return typeof proposal?.revision === 'number' ? proposal.revision : 0;
}

/** An edit of `target` on the answer's current proposal at the revision it shows. */
export function editOf(answer: Answer, target: Target, change: Change): EditSpec {
  assert.ok(answer.proposal, `nothing to edit: ${show(answer)}`);
  return { proposalId: answer.proposal!.proposalId, revision: revisionOf(answer.proposal), target, change };
}

export interface EditOptions {
  timezone?: string;
  referenceTime?: string;
  locale?: 'ar' | 'en' | 'he';
}

export async function editRaw(uid: string, conversationId: string, spec: EditSpec, options: EditOptions = {}): Promise<Raw> {
  return chatRaw(uid, {
    conversationId,
    edit: spec,
    timezone: options.timezone ?? TZ,
    referenceTime: options.referenceTime ?? REFERENCE,
    ...(options.locale ? { locale: options.locale } : {}),
  });
}

/** An edit the server must apply: 200 and a chat answer with a proposal. */
export async function edit(uid: string, conversationId: string, spec: EditSpec, options: EditOptions = {}): Promise<Answer> {
  const result = await editRaw(uid, conversationId, spec, options);
  assert.equal(result.status, 200, `the edit ${show(spec.change)} answered ${result.status}: ${show(result.body)}`);
  const answer = result.body as Answer;
  assert.equal(answer.conversationId, conversationId, 'the edit answered for another conversation');
  assert.ok(answer.proposal, `the edit answered no proposal: ${show(answer)}`);
  return answer;
}

/** A refused edit: 400 `edit_invalid`. */
export function assertEditInvalid(result: Raw, label: string): void {
  assert.equal(result.status, 400, `${label}: answered ${result.status}, not 400 edit_invalid: ${show(result.body)}`);
  assert.equal(result.body?.reason, 'edit_invalid', `${label}: the 400 is not edit_invalid: ${show(result.body)}`);
}

/** The chat edit's 409: `{ reason: 'proposal_changed', answer }` — returns the current answer. */
export function assertChatConflict(result: Raw, label: string): Answer {
  assert.equal(result.status, 409, `${label}: answered ${result.status}, not 409 proposal_changed: ${show(result.body)}`);
  assert.equal(result.body?.reason, 'proposal_changed', `${label}: the 409 is not proposal_changed: ${show(result.body)}`);
  assert.ok(result.body?.answer && typeof result.body.answer === 'object', `${label}: the 409 carries no current answer: ${show(result.body)}`);
  return result.body.answer as Answer;
}

/** The confirm/clarify/keep 409: `{ reason, proposal, state, confirmation? }` — returns the current proposal. */
export function assertProposalConflict(result: Raw, label: string, state: 'open' | 'confirmed'): Proposal {
  assert.equal(result.status, 409, `${label}: answered ${result.status}, not 409 proposal_changed: ${show(result.body)}`);
  assert.equal(result.body?.reason, 'proposal_changed', `${label}: the 409 is not proposal_changed: ${show(result.body)}`);
  assert.ok(result.body?.proposal && typeof result.body.proposal === 'object', `${label}: the 409 carries no current proposal: ${show(result.body)}`);
  assert.equal(result.body.state, state, `${label}: the 409's state is ${result.body.state}, not ${state}`);
  assert.equal(typeof result.body.proposal.revision, 'number', `${label}: the current proposal carries no revision`);
  return result.body.proposal as Proposal;
}

/* ── clarify, confirm, seeds ──────────────────────────────────────── */

export async function clarifyRaw(
  uid: string,
  proposal: Proposal,
  item: Item,
  answer: { optionId?: string; freeText?: string },
  options: { revision?: number; timezone?: string; referenceTime?: string } = {},
): Promise<Raw> {
  assert.ok(item.clarification, `«${item.title}» asks nothing`);
  return raw(await clarifyPost(request('/api/mobile/capture/clarify', uid, {
    proposalId: proposal.proposalId,
    itemId: item.itemId,
    questionId: item.clarification!.questionId,
    ...answer,
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    timezone: options.timezone ?? TZ,
    referenceTime: options.referenceTime ?? REFERENCE,
  })));
}

export async function confirmRaw(uid: string, body: Record<string, unknown>): Promise<Raw> {
  return raw(await confirmPost(request('/api/mobile/capture/confirm', uid, body)));
}

export async function keepSeedRaw(uid: string, body: Record<string, unknown>): Promise<Raw> {
  return raw(await seedsPost(request('/api/mobile/seeds', uid, body)));
}

export async function keptSeeds(uid: string): Promise<Array<{ kind: string; summary: string; sourceRef: string | null }>> {
  const result = await raw(await seedsGet(request('/api/mobile/seeds', uid)));
  assert.equal(result.status, 200, `GET /seeds answered ${result.status}: ${show(result.body)}`);
  return result.body.items;
}

export type Saved = { title: string; timeSpec: { dueAt?: string | null; endAt?: string | null; timezone?: string; allDay?: boolean } };

/** Every commitment this account has, as the participant state holds it. */
export async function savedCommitments(uid: string): Promise<Saved[]> {
  return (Object.values((await getParticipantStateSnapshot(uid)).commitments) as Saved[])
    .map((commitment) => ({ title: commitment.title, timeSpec: commitment.timeSpec }));
}

/* ── the model's objects, in the extraction schema (+ M2a `kind`) ── */

export function modelItem(
  title: string,
  date: string | null,
  time: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const instant = date && time ? at(date, time) : null;
  return {
    type: 'task',
    action: title,
    title,
    person: null,
    dueAt: instant,
    remindAt: instant,
    localTimeSpec: date ? { date, time, timezone: TZ } : null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 0.92, type: 0.95, action: 0.9, time: instant ? 0.9 : 0, priority: 0.7 },
    missingFields: instant ? [] : ['time'],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
    ...extra,
  };
}

/**
 * What the model reports for a mishearing it fixed (condition 1). ASSUMPTION
 * of this gate: the contract fixes the server's output (`item.corrections[]`
 * with server-minted ids) but not the model's JSON, so the scripted model
 * reports `corrections: [{ from, to }]` on the item — no id, the server mints
 * it. If the builder names the model's field differently, this is the one
 * place to change.
 */
export function modelCorrections(...pairs: Array<[from: string, to: string]>): Record<string, unknown> {
  return { corrections: pairs.map(([from, to]) => ({ from, to })) };
}

export function modelAnswer(reply: string, action: 'propose' | 'update' | 'ask' | 'chat', items: unknown[]): Record<string, unknown> {
  return { reply, action, items };
}

/* ── what the contract holds an answer to ─────────────────────────── */

const URL_LIKE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|app|ly|co|me|info|link|to|gl)\b/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** Contract v3 (M2a) invariants of `understood`, re-held after every edit. */
export function assertUnderstoodValid(proposal: Proposal | null, label = 'proposal'): Point[] {
  assert.ok(proposal, `${label}: no proposal`);
  const points = proposal!.understood;
  assert.ok(Array.isArray(points), `${label} carries no understood[] (got ${show(points)})`);
  const itemIds = proposal!.items.map((item) => item.itemId);
  const seedKinds = new Map(proposal!.seeds.map((seed) => [seed.seedItemId, seed.kind]));
  const seenItems: string[] = [];
  const seenSeeds: string[] = [];
  for (const point of points!) {
    assert.equal(typeof point.text, 'string', `${label}: a point without text: ${show(point)}`);
    assert.ok(point.text.trim().length > 0, `${label}: an empty understood line`);
    assert.ok(point.text.length <= 160, `${label}: an understood line of ${point.text.length} characters`);
    assert.ok(!URL_LIKE.test(point.text), `${label}: an understood line carries a link: ${point.text}`);
    assert.ok(!CONTROL.test(point.text), `${label}: an understood line carries control characters`);
    assert.ok(!claimsSaved(point.text), `${label}: an understood line claims something was saved: ${point.text}`);
    if (point.kind === 'commitment') {
      assert.ok(itemIds.includes(point.itemId), `${label}: a commitment point names no item: ${show(point)}`);
      seenItems.push(point.itemId);
    } else {
      assert.ok(seedKinds.has(point.seedItemId), `${label}: a seed point names no seed: ${show(point)}`);
      assert.equal(point.kind, seedKinds.get(point.seedItemId), `${label}: a seed point's kind is not its seed's kind`);
      seenSeeds.push(point.seedItemId);
    }
  }
  assert.deepEqual([...seenItems].sort(), [...itemIds].sort(), `${label}: understood does not name every item exactly once`);
  assert.deepEqual([...seenSeeds].sort(), Array.from(seedKinds.keys()).sort(), `${label}: understood does not name every seed exactly once`);
  return points!;
}

/** The ids of the understood points, in order (an item's id or a seed's id). */
export function understoodIds(proposal: Proposal | null, label = 'proposal'): string[] {
  return assertUnderstoodValid(proposal, label).map((point) => (point.kind === 'commitment' ? point.itemId : point.seedItemId));
}

/** The understood line of one point, by its id. */
export function lineOf(proposal: Proposal | null, id: string): Point {
  const point = assertUnderstoodValid(proposal).find((candidate) =>
    (candidate.kind === 'commitment' ? candidate.itemId : candidate.seedItemId) === id);
  assert.ok(point, `no understood line names ${id}`);
  return point!;
}

/**
 * One structured edit's turns: exactly one user turn and the assistant's
 * acknowledgement were added, the user turn is human-readable (not JSON, no
 * ids), and the acknowledgement is the reply.
 */
export function assertOneTurnPair(before: Answer, after: Answer, label: string): void {
  const grew = after.turns.length - before.turns.length;
  assert.equal(grew, 2, `${label}: the edit added ${grew} turns, not one user turn and one acknowledgement`);
  const [user, assistant] = after.turns.slice(-2);
  assert.equal(user!.role, 'user', `${label}: the edit's first turn is not the person's`);
  assert.equal(assistant!.role, 'assistant', `${label}: the edit's second turn is not the assistant's`);
  assert.ok(user!.text.trim().length > 0, `${label}: the edit's user turn is empty`);
  assert.ok(!/^\s*[{[]/.test(user!.text), `${label}: the edit's user turn is JSON, not words: ${user!.text}`);
  const ids = [...(after.proposal?.items.map((item) => item.itemId) ?? []), ...(after.proposal?.seeds.map((seed) => seed.seedItemId) ?? [])];
  for (const id of ids) assert.ok(!user!.text.includes(id), `${label}: the edit's user turn shows an id: ${user!.text}`);
  assert.equal(assistant!.text, after.reply, `${label}: the recorded acknowledgement is not the reply`);
}

/** The JSON size of every capture document this account holds (conversations, proposals, edit receipts). */
export async function captureFootprint(uid: string): Promise<{ documents: number; bytes: number }> {
  const store = currentStorage();
  let documents = 0;
  let bytes = 0;
  for (const path of store.pathsForTests()) {
    if (!path.includes(uid)) continue;
    if (!/capture|receipt|edit/i.test(path)) continue;
    documents += 1;
    bytes += JSON.stringify(await store.get(path)).length;
  }
  return { documents, bytes };
}

/* ── messages whose rules-path proposals were read on d93a9a2b ───── */

/** One item «اتصل بأمي» tomorrow 17:00, then one consideration seed «…أسافر الصيف الجاي». */
export const CALL_AND_TRAVEL = 'لازم اتصل بأمي بكرا الساعة 5 المسا، وعم بفكر أسافر الصيف الجاي';
/** One ranged item «اجتماع» tomorrow 16:00–20:00, then the consideration seed. */
export const RANGE_AND_TRAVEL = 'اجتماع بكرا من 4 لـ 8 المسا، وعم بفكر أسافر الصيف الجاي';
/** One item «موعد الدكتور» asking «الصبح ولا المسا؟» (status needs_clarification). */
export const DOCTOR = 'موعد الدكتور بكرا الساعة 4';
/** «موعد الدكتور» asking «الصبح ولا المسا؟», then the consideration seed. */
export const DOCTOR_AND_TRAVEL = 'موعد الدكتور بكرا الساعة 4، وعم بفكر أسافر الصيف الجاي';

/** The one item whose title carries `words`. */
export function itemWith(proposal: Proposal | null, words: string): Item {
  const found = proposal?.items.filter((item) => item.title.includes(words)) ?? [];
  assert.equal(found.length, 1, `not one item with «${words}»: ${show(proposal?.items)}`);
  return found[0]!;
}

/** The one seed whose summary carries `words`. */
export function seedWith(proposal: Proposal | null, words: string): Seed {
  const found = proposal?.seeds.filter((seed) => seed.summary.includes(words)) ?? [];
  assert.equal(found.length, 1, `not one seed with «${words}»: ${show(proposal?.seeds)}`);
  return found[0]!;
}

/** The one item with this id. */
export function itemById(proposal: Proposal | null, itemId: string): Item {
  const found = proposal?.items.find((item) => item.itemId === itemId);
  assert.ok(found, `no item ${itemId}: ${show(proposal?.items)}`);
  return found!;
}

/** The one seed with this id. */
export function seedById(proposal: Proposal | null, seedItemId: string): Seed {
  const found = proposal?.seeds.find((seed) => seed.seedItemId === seedItemId);
  assert.ok(found, `no seed ${seedItemId}: ${show(proposal?.seeds)}`);
  return found!;
}
