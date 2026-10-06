/**
 * M2a Task B acceptance gate (evidence/claudex-20261006/M2/PLAN-B.md), shared
 * harness. Written by the independent acceptance-test writer, not a builder.
 *
 * Every test drives the real chat route in-process (`POST
 * /api/mobile/capture/chat`) with fake auth and memory storage: the rules path
 * with no model at all, the model path with a scripted model answer. The
 * reference time is fixed — never the real clock — so no day here goes stale.
 *
 * Only what the plan and the shared contract v3 name is asserted: `items`,
 * `seeds`, `understood[]`, `endTime`, `timeSpec.endAt`, the reply's structure,
 * and the OLD strings that must disappear. New copy is the builders' to choose.
 */
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../../support/fakeAuth.ts';
import { POST as chatPost } from '../../../src/app/api/mobile/capture/chat/route.ts';
import { POST as clarifyPost } from '../../../src/app/api/mobile/capture/clarify/route.ts';
import { POST as confirmPost } from '../../../src/app/api/mobile/capture/confirm/route.ts';
import { setCaptureChatDependenciesForTests } from '../../../lib/services/captureChat/captureChatService.ts';
import { claimsSaved, detectChatLanguage, type ChatLanguage } from '../../../lib/services/captureChat/chatReply.ts';
import { getParticipantStateSnapshot } from '../../../lib/services/mobile/participantState.ts';
import { instantFromLocal } from '../../../src/extraction/timeLexicon.ts';
import type { LLMProviderFunction } from '../../../src/extraction/llm/index.ts';

const BASE = 'http://localhost:3000';
export const TZ = 'Asia/Jerusalem';

/** Wednesday 2026-10-07, 10:00 in Jerusalem (UTC+3). Fixed: never the real clock. */
export const REFERENCE = '2026-10-07T07:00:00.000Z';
export const TODAY = '2026-10-07';
/** «بكرا», and also «يوم الخميس» from the reference. */
export const TOMORROW = '2026-10-08';

export function at(date: string, time: string, zone: string = TZ): string {
  return instantFromLocal(date, time, zone)!.toISOString();
}

/* ── shapes read from the answers ─────────────────────────────────── */

export type Point =
  | { kind: 'commitment'; itemId: string; text: string }
  | { kind: 'possible_goal' | 'consideration' | 'idea' | 'waiting_for'; seedItemId: string; text: string };
export type Item = {
  itemId: string;
  title: string;
  resolvedTime: string | null;
  resolvedDate?: string;
  endTime?: string;
  needsClarification: boolean;
  clarification?: { questionId: string; questionKey?: string; options: Array<{ optionId: string }> } | null;
};
export type Seed = { seedItemId: string; kind: string; summary: string };
export type Proposal = {
  proposalId: string;
  status: string;
  items: Item[];
  seeds: Seed[];
  understood?: Point[];
};
export type ChatBody = { conversationId: string; reply: string; engine: 'model' | 'rules'; proposal: Proposal | null };

/* ── harness ──────────────────────────────────────────────────────── */

let auth: FakeAuthControls | null = null;
let counter = 0;

/** The rules path: no model for this account. */
export function beginRules(): string {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  setCaptureChatDependenciesForTests({ llmProviderFor: () => null });
  return uidFor(`AccM2aRules${counter++}`);
}

/** The model path: a scripted model answering `answers` in order (the last one repeats). */
export function beginModel(...answers: unknown[]): string {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  let calls = 0;
  const provider: LLMProviderFunction = async () => JSON.stringify(answers[Math.min(calls++, answers.length - 1)]);
  setCaptureChatDependenciesForTests({ llmProviderFor: () => provider });
  return uidFor(`AccM2aModel${counter++}`);
}

export function end(): void {
  setCaptureChatDependenciesForTests(null);
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function post(path: string, uid: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface ChatOptions {
  conversationId?: string;
  locale?: ChatLanguage;
  timezone?: string;
  referenceTime?: string;
}

export async function chat(uid: string, message: string, options: ChatOptions = {}): Promise<ChatBody> {
  const response = await chatPost(post('/api/mobile/capture/chat', uid, {
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    message,
    timezone: options.timezone ?? TZ,
    referenceTime: options.referenceTime ?? REFERENCE,
    ...(options.locale ? { locale: options.locale } : {}),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, `chat answered ${response.status}: ${JSON.stringify(body)}`);
  return body as ChatBody;
}

/** Answer one item's clarification through the card's own route. */
export async function clarify(
  uid: string,
  proposal: Proposal,
  item: Item,
  answer: { optionId?: string; freeText?: string },
  options: { timezone?: string; referenceTime?: string } = {},
): Promise<Proposal> {
  assert.ok(item.clarification, `«${item.title}» asks nothing`);
  const response = await clarifyPost(post('/api/mobile/capture/clarify', uid, {
    proposalId: proposal.proposalId,
    itemId: item.itemId,
    questionId: item.clarification!.questionId,
    ...answer,
    timezone: options.timezone ?? TZ,
    referenceTime: options.referenceTime ?? REFERENCE,
  }));
  const body = await response.json();
  assert.equal(response.status, 200, `clarify answered ${response.status}: ${JSON.stringify(body)}`);
  return body as Proposal;
}

/** Confirm the items and return the stored commitments' time specs, by title. */
export async function confirmAndReadTimeSpecs(uid: string, proposal: Proposal, itemIds: string[]): Promise<Array<{ title: string; timeSpec: { dueAt?: string | null; endAt?: string | null } }>> {
  const response = await confirmPost(post('/api/mobile/capture/confirm', uid, { proposalId: proposal.proposalId, itemIds }));
  const body = await response.json() as { success: boolean };
  assert.equal(response.status, 200, `confirm answered ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(body.success, true, `confirm failed: ${JSON.stringify(body)}`);
  const commitments = Object.values((await getParticipantStateSnapshot(uid)).commitments) as Array<{ title: string; timeSpec: { dueAt?: string | null; endAt?: string | null } }>;
  return commitments.map((commitment) => ({ title: commitment.title, timeSpec: commitment.timeSpec }));
}

/* ── the model's objects, in the extraction schema (+ M2a `kind`) ── */

export type ModelKind = 'commitment' | 'possible_goal' | 'consideration' | 'idea' | 'waiting_for';

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

export function modelFirstAnswer(reply: string, action: 'propose' | 'update' | 'ask' | 'chat', items: unknown[]): Record<string, unknown> {
  return {
    reply,
    action,
    locked: [],
    open: [],
    added: action === 'chat' ? [] : items,
  };
}

/* ── what the plan holds an answer to ─────────────────────────────── */

const URL_LIKE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|app|ly|co|me|info|link|to|gl)\b/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Contract v3 server invariants of `understood`: present; refs exist; each item
 * and each seed exactly once; a seed point's kind is the seed's kind; text ≤ 160,
 * plain, no URL, no controls, no saved-claim. Returns the points.
 */
export function assertUnderstoodValid(proposal: Proposal | null, label = 'proposal'): Point[] {
  assert.ok(proposal, `${label}: no proposal`);
  const points = proposal!.understood;
  assert.ok(Array.isArray(points), `${label} carries no understood[] (got ${JSON.stringify(points)})`);
  const itemIds = proposal!.items.map((item) => item.itemId);
  const seedKinds = new Map(proposal!.seeds.map((seed) => [seed.seedItemId, seed.kind]));
  const seenItems: string[] = [];
  const seenSeeds: string[] = [];
  for (const point of points!) {
    assert.equal(typeof point.text, 'string', `${label}: a point without text: ${JSON.stringify(point)}`);
    assert.ok(point.text.trim().length > 0, `${label}: an empty understood line`);
    assert.ok(point.text.length <= 160, `${label}: an understood line of ${point.text.length} characters: ${point.text}`);
    assert.ok(!URL_LIKE.test(point.text), `${label}: an understood line carries a link: ${point.text}`);
    assert.ok(!CONTROL.test(point.text), `${label}: an understood line carries control characters`);
    assert.ok(!claimsSaved(point.text), `${label}: an understood line claims something was saved: ${point.text}`);
    if (point.kind === 'commitment') {
      assert.ok(itemIds.includes(point.itemId), `${label}: a commitment point names no item: ${JSON.stringify(point)}`);
      seenItems.push(point.itemId);
    } else {
      assert.ok(seedKinds.has(point.seedItemId), `${label}: a seed point names no seed: ${JSON.stringify(point)}`);
      assert.equal(point.kind, seedKinds.get(point.seedItemId), `${label}: a seed point's kind is not its seed's kind`);
      seenSeeds.push(point.seedItemId);
    }
  }
  assert.deepEqual([...seenItems].sort(), [...itemIds].sort(), `${label}: understood does not name every item exactly once`);
  assert.deepEqual([...seenSeeds].sort(), Array.from(seedKinds.keys()).sort(), `${label}: understood does not name every seed exactly once`);
  return points!;
}

/**
 * The understood points as the speech keywords their items' titles or seeds'
 * summaries carry, in the points' order — to compare with the order said.
 */
export function understoodKeywords(proposal: Proposal, keywords: readonly string[]): string[] {
  const points = assertUnderstoodValid(proposal);
  return points.map((point) => {
    const source = point.kind === 'commitment'
      ? proposal.items.find((item) => item.itemId === point.itemId)!.title
      : proposal.seeds.find((seed) => seed.seedItemId === point.seedItemId)!.summary;
    const found = keywords.filter((keyword) => source.includes(keyword));
    assert.equal(found.length, 1, `point ${JSON.stringify(point)} (from «${source}») matches ${found.length} of the keywords`);
    return found[0]!;
  });
}

/** An understood line's language, by its letters (the product's own detector). */
export function lineLanguage(text: string): ChatLanguage {
  return detectChatLanguage(text, 'ar');
}

/** A reply's sentences, each with its own end mark. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?؟…])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}
