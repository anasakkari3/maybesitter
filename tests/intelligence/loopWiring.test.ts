/**
 * The proactive loop as production reaches it (review of 2026-10-03,
 * audit/2026-10-03/stitch-production-blackbox/PROACTIVE-LOOP-WIRING-REVIEW.md).
 *
 * The loop was released to production on 2026-10-01, but outcome learning ran
 * only inside `POST /intelligence/generate`, which no production screen
 * called. What is pinned here, through the real route handlers and a fake
 * model:
 *
 *   - completing, postponing and dropping a commitment become outcome
 *     observations at once, with no generation, once per event — even after a
 *     rename — and only with the loop on and personalization consent given;
 *   - a postpone is recorded as a postpone, never as a failure;
 *   - a screen visit cannot multiply model calls: inside the visit floor it
 *     reuses the latest run; the explicit button keeps the digest rule;
 *   - the review's end-to-end steps 1, 2, 3 and 5 at route level.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage, resetStorageForTests, setStorageForTests, type StorageAdapter } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { applyParticipantCommands, loadDomainState } from '../../lib/services/mobile/participantState.ts';
import { setPersonalizationConsent } from '../../lib/consents/personalizationConsentService.ts';
import { PERSONALIZATION_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { learnFromCommitmentEvents } from '../../lib/intelligence/outcomeLearning.ts';
import { putObservations, type StoredObservation } from '../../lib/intelligence/observationStore.ts';
import {
  VISIT_GENERATION_MIN_INTERVAL_MS, proposeFromObservations, setIntelligenceGeneratorForTests,
} from '../../lib/intelligence/proposalEngine.ts';
import { BEGIN_UNTRUSTED_SHARED_CONTENT, END_UNTRUSTED_SHARED_CONTENT } from '../../lib/services/share/shareTypes.ts';
import type { ShareStructuredGenerator } from '../../lib/llm/shareProvider.ts';
import { GET as inboxGet, POST as statementPost } from '../../src/app/api/mobile/intelligence/route.ts';
import { POST as generatePost } from '../../src/app/api/mobile/intelligence/generate/route.ts';
import { POST as decisionPost } from '../../src/app/api/mobile/intelligence/suggestions/[id]/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';
import { DELETE as commitmentDelete, PATCH as commitmentPatch } from '../../src/app/api/mobile/commitments/[id]/route.ts';

const BASE = 'http://127.0.0.1:4321';
const UID = uidFor('LoopWiringUser');
const ENV_KEYS = ['MAYBESITTER_ENV', 'MAYBESITTER_FEATURE_PROACTIVE_LOOP', 'MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP', 'MAYBESITTER_LLM_PROVIDER'] as const;

interface Harness { storage: StorageAdapter; calls: ModelCall[]; restore: () => void }
interface ModelCall { system: string; context: { observations: Array<{ id: string; kind: string; evidence: string }> } }
type Reply = (call: ModelCall) => unknown;

/** Production, the loop flag on, no real model: a fake answers through the engine's seam. */
function begin(reply: Reply = () => ({ suggestions: [] })): Harness {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.MAYBESITTER_ENV = 'production';
  process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP = 'true';
  delete process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP;
  process.env.MAYBESITTER_LLM_PROVIDER = 'none';
  const auth: FakeAuthControls = installFakeAuth();
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const calls: ModelCall[] = [];
  const generate: ShareStructuredGenerator = async request => {
    const text = request.parts.map(part => part.kind === 'text' ? part.text : '').join('');
    const json = text.slice(text.indexOf(BEGIN_UNTRUSTED_SHARED_CONTENT) + BEGIN_UNTRUSTED_SHARED_CONTENT.length,
      text.indexOf(END_UNTRUSTED_SHARED_CONTENT));
    const call: ModelCall = { system: String(request.system ?? ''), context: JSON.parse(json) };
    calls.push(call);
    return { text: JSON.stringify(reply(call)), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
  };
  setIntelligenceGeneratorForTests(generate);
  return {
    storage, calls,
    restore: () => {
      setIntelligenceGeneratorForTests(null);
      resetStorageForTests();
      auth.restore();
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    },
  };
}

function req(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(UID)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const act = (id: string, action: string, extra: Record<string, unknown> = {}) =>
  actionPost(req(`/api/mobile/commitments/${id}/actions`, 'POST', { action, ...extra }), params(id));

async function grantPersonalization(storage: StorageAdapter): Promise<void> {
  await setPersonalizationConsent(UID, {
    state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(Date.now() - 60_000),
  }, { storage });
}

async function seedCommitment(id: string, title: string): Promise<void> {
  const now = new Date().toISOString();
  await applyParticipantCommands(UID, [
    { type: 'CreateDraft', now, commitment: {
      id, kind: 'task', title,
      timeSpec: { kind: 'due_by', dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), timezone: 'UTC' },
    } },
    { type: 'ConfirmCommitment', commitmentId: id, now },
  ]);
}

async function outcomes(storage: StorageAdapter): Promise<StoredObservation[]> {
  return (await storage.list<StoredObservation>(`users/${UID}/intelligenceObservations`))
    .map(row => row.data).filter(item => item.source === 'behavior');
}

const later = () => new Date(Date.now() + 26 * 3_600_000).toISOString();
const ID_DONE = '1a2b3c4d-0000-4000-8000-000000000001';
const ID_MOVED = '1a2b3c4d-0000-4000-8000-000000000002';
const ID_DROPPED = '1a2b3c4d-0000-4000-8000-000000000003';

test('completed, postponed and dropped become outcome evidence as they happen, with no generation', async () => {
  const h = begin();
  try {
    await grantPersonalization(h.storage);
    await seedCommitment(ID_DONE, 'Call the clinic');
    await seedCommitment(ID_MOVED, 'Renew the passport');
    await seedCommitment(ID_DROPPED, 'Fix the old bike');

    assert.equal((await act(ID_DONE, 'complete')).status, 200);
    assert.equal((await act(ID_MOVED, 'postpone', { postponedUntil: later() })).status, 200);
    assert.equal((await commitmentDelete(req(`/api/mobile/commitments/${ID_DROPPED}`, 'DELETE'), params(ID_DROPPED))).status, 200);

    // Nobody opened the loop's screen and no model ran, yet the loop knows.
    assert.equal(h.calls.length, 0);
    const learned = await outcomes(h.storage);
    assert.deepEqual(learned.map(item => item.evidence).sort(), [
      'Completed: Call the clinic', 'Dropped: Fix the old bike', 'Postponed: Renew the passport',
    ]);
    for (const item of learned) assert.equal(item.kind, 'outcome');

    // Postponing moves a thing; it is never written down as failing it.
    const moved = learned.find(item => item.evidence.includes('Renew the passport'))!;
    assert.doesNotMatch(moved.evidence, /fail|miss|didn.t|not done|abandon/i);
  } finally { h.restore(); }
});

test('one event is one observation, across re-reads, a reopened app and a rename', async () => {
  const h = begin();
  try {
    await grantPersonalization(h.storage);
    await seedCommitment(ID_MOVED, 'Renew the passport');
    assert.equal((await act(ID_MOVED, 'postpone', { postponedUntil: later() })).status, 200);
    assert.equal((await outcomes(h.storage)).length, 1);

    // Reopening the app reads the inbox again, more than once.
    for (let i = 0; i < 3; i += 1) assert.equal((await inboxGet(req('/api/mobile/intelligence'))).status, 200);
    assert.equal((await outcomes(h.storage)).length, 1);

    // The same postpone event, read again after the commitment was renamed:
    // the event id, not the title, decides whether it is already known.
    const renamed = await commitmentPatch(req(`/api/mobile/commitments/${ID_MOVED}`, 'PATCH', { title: 'Renew the passport today' }), params(ID_MOVED));
    assert.equal(renamed.status, 200);
    assert.equal((await loadDomainState(h.storage, UID)).commitments[ID_MOVED]?.title, 'Renew the passport today');
    await learnFromCommitmentEvents(UID, h.storage);
    assert.equal((await inboxGet(req('/api/mobile/intelligence'))).status, 200);
    const learned = await outcomes(h.storage);
    assert.equal(learned.length, 1, `one postpone became ${learned.length} observations: ${learned.map(item => item.evidence).join(' | ')}`);
  } finally { h.restore(); }
});

test('an outcome written by another path is caught up the next time the inbox is read', async () => {
  const h = begin();
  try {
    await grantPersonalization(h.storage);
    await seedCommitment(ID_DONE, 'Call the clinic');
    // Not through the actions route: a scheduled job or another writer.
    await applyParticipantCommands(UID, [{ type: 'Complete', commitmentId: ID_DONE, now: new Date().toISOString() }]);
    assert.equal((await outcomes(h.storage)).length, 0);
    const inbox = await (await inboxGet(req('/api/mobile/intelligence'))).json() as { observations: StoredObservation[] };
    assert.ok(inbox.observations.some(item => item.evidence === 'Completed: Call the clinic'));
    assert.equal(h.calls.length, 0);
  } finally { h.restore(); }
});

test('outcome learning needs the loop on and personalization consent; the action never fails for it', async () => {
  const h = begin();
  try {
    // No personalization consent: the action works and nothing is learned.
    await seedCommitment(ID_DONE, 'Call the clinic');
    assert.equal((await act(ID_DONE, 'complete')).status, 200);
    assert.equal((await outcomes(h.storage)).length, 0);

    // Consent given, kill switch on: still nothing, still no error.
    await grantPersonalization(h.storage);
    process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP = 'true';
    await seedCommitment(ID_MOVED, 'Renew the passport');
    assert.equal((await act(ID_MOVED, 'postpone', { postponedUntil: later() })).status, 200);
    assert.equal((await outcomes(h.storage)).length, 0);

    // Kill switch off again: the next action catches up on both events.
    delete process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP;
    await seedCommitment(ID_DROPPED, 'Fix the old bike');
    assert.equal((await act(ID_DROPPED, 'cancel')).status, 200);
    assert.equal((await outcomes(h.storage)).length, 3);
  } finally { h.restore(); }
});

test('a postpone reaches the model as a postpone, and the model is told it is not a failure', async () => {
  const h = begin();
  try {
    await grantPersonalization(h.storage);
    await seedCommitment(ID_MOVED, 'Renew the passport');
    assert.equal((await act(ID_MOVED, 'postpone', { postponedUntil: later() })).status, 200);
    assert.equal((await generatePost(req('/api/mobile/intelligence/generate', 'POST', {}))).status, 200);
    assert.equal(h.calls.length, 1);
    const call = h.calls[0]!;
    assert.ok(call.context.observations.some(item => item.kind === 'outcome' && item.evidence === 'Postponed: Renew the passport'));
    assert.match(call.system, /Postponed means the person moved the item to a later time\. It is not a failure/);
  } finally { h.restore(); }
});

test('screen visits cannot multiply model calls; the explicit button still reads a new signal', async () => {
  const h = begin(call => ({ suggestions: [{
    kind: 'action', title: `Prepare for ${call.context.observations.length} things`, reason: 'From what you told me',
    observationIds: [call.context.observations[0]!.id], confidence: 0.8, durationMinutes: 30,
  }] }));
  try {
    await seedCommitment(ID_DONE, 'Call the clinic');
    const visit = () => generatePost(req('/api/mobile/intelligence/generate', 'POST', { trigger: 'visit' }));
    const first = await visit();
    assert.equal(first.status, 200);
    assert.equal(h.calls.length, 1);
    const firstIds = ((await first.json()) as { suggestions: Array<{ id: string }> }).suggestions.map(item => item.id);
    assert.equal(firstIds.length, 1);

    // Something changed (a new commitment), and Today and «يتابع لك» are opened
    // again and again: no further model call inside the floor, and each visit
    // still gets the latest suggestions back.
    await seedCommitment(ID_MOVED, 'Renew the passport');
    for (let i = 0; i < 5; i += 1) {
      const again = await visit();
      assert.equal(again.status, 200);
      assert.deepEqual(((await again.json()) as { suggestions: Array<{ id: string }> }).suggestions.map(item => item.id), firstIds);
    }
    assert.equal(h.calls.length, 1);

    // The explicit request (the panel's button, or an older client's `{}`)
    // keeps the digest rule: the changed context is read at once.
    assert.equal((await generatePost(req('/api/mobile/intelligence/generate', 'POST', {}))).status, 200);
    assert.equal(h.calls.length, 2);
  } finally { h.restore(); }
});

test('the visit floor is exactly the window: reused inside it, regenerated at its edge', async () => {
  const storage = createMemoryStorage();
  const T0 = '2026-10-03T08:00:00.000Z';
  let calls = 0;
  const generate: ShareStructuredGenerator = async () => {
    calls += 1;
    return { text: JSON.stringify({ suggestions: [] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
  };
  await putObservations(UID, 'manual', 'n1', T0, [{ kind: 'goal', evidence: 'I want to learn React', confidence: 0.9 }], storage);
  await proposeFromObservations(UID, T0, { storage, generate, minIntervalMs: VISIT_GENERATION_MIN_INTERVAL_MS });
  assert.equal(calls, 1);
  // A new signal: the digest changes, so only the floor stands between it and the model.
  await putObservations(UID, 'manual', 'n2', T0, [{ kind: 'event', evidence: 'Exam tomorrow', confidence: 0.9 }], storage);
  const inside = new Date(Date.parse(T0) + VISIT_GENERATION_MIN_INTERVAL_MS - 1_000).toISOString();
  await proposeFromObservations(UID, inside, { storage, generate, minIntervalMs: VISIT_GENERATION_MIN_INTERVAL_MS });
  assert.equal(calls, 1);
  const edge = new Date(Date.parse(T0) + VISIT_GENERATION_MIN_INTERVAL_MS).toISOString();
  await proposeFromObservations(UID, edge, { storage, generate, minIntervalMs: VISIT_GENERATION_MIN_INTERVAL_MS });
  assert.ok(calls > 1, 'a visit after the floor must be allowed to read the new signal');
});

test('E2E 1-3: exam and React become reviewable suggestions; accept, complete, postpone are learned, never auto-saved', async () => {
  const h = begin(call => {
    const exam = call.context.observations.find(item => item.kind === 'event');
    const react = call.context.observations.find(item => item.kind === 'goal');
    return { suggestions: [
      ...(exam ? [{ kind: 'action', title: 'راجع مادة الامتحان', reason: 'عندك امتحان بكرا', observationIds: [exam.id], confidence: 0.8, durationMinutes: 45 }] : []),
      ...(react ? [
        { kind: 'action', title: 'اعمل مشروع React صغير', reason: 'بدك تتعلم React', observationIds: [react.id], confidence: 0.7, durationMinutes: 60 },
        { kind: 'question', title: 'قديش جاهز للامتحان؟', reason: 'ما بعرف قديش حضّرت', observationIds: [exam?.id ?? react.id], confidence: 0.6, durationMinutes: 0 },
      ] : []),
    ] };
  });
  try {
    await grantPersonalization(h.storage);
    // 1. A new account says two things.
    for (const text of ['عندي امتحان بكرا', 'بدي اتعلم React']) {
      assert.equal((await statementPost(req('/api/mobile/intelligence', 'POST', { text }))).status, 201);
    }
    assert.equal((await generatePost(req('/api/mobile/intelligence/generate', 'POST', { trigger: 'visit' }))).status, 200);
    const inbox = await (await inboxGet(req('/api/mobile/intelligence'))).json() as {
      observations: StoredObservation[]; suggestions: Array<{ id: string; kind: string; title: string; status: string; observationIds: string[] }>;
    };
    const pending = inbox.suggestions.filter(item => item.status === 'pending');
    assert.deepEqual(pending.map(item => item.kind).sort(), ['action', 'action', 'question']);
    const evidence = new Map(inbox.observations.map(item => [item.id, item.evidence]));
    for (const item of pending) assert.ok(item.observationIds.every(id => evidence.has(id)), `${item.title} names evidence the inbox does not show`);
    // Nothing became a commitment on its own.
    assert.equal(Object.keys((await loadDomainState(h.storage, UID)).commitments).length, 0);

    // 2. One action is accepted, then completed.
    const prep = pending.find(item => item.title === 'راجع مادة الامتحان')!;
    const accepted = await decisionPost(req(`/api/mobile/intelligence/suggestions/${prep.id}`, 'POST', { decision: 'accept' }), params(prep.id));
    assert.equal(accepted.status, 200);
    const commitmentId = ((await accepted.json()) as { suggestion: { linkedEntityId: string } }).suggestion.linkedEntityId;
    assert.equal(Object.keys((await loadDomainState(h.storage, UID)).commitments).length, 1);
    const callsBefore = h.calls.length;
    assert.equal((await act(commitmentId, 'complete')).status, 200);
    assert.equal(h.calls.length, callsBefore, 'learning an outcome must not need a model call');
    const reopened = await (await inboxGet(req('/api/mobile/intelligence'))).json() as { observations: StoredObservation[] };
    assert.ok(reopened.observations.some(item => item.kind === 'outcome' && item.source === 'behavior' && item.evidence === 'Completed: راجع مادة الامتحان'));
    // The next generation reads that outcome and does not offer the done thing again.
    const next = await generatePost(req('/api/mobile/intelligence/generate', 'POST', {}));
    assert.equal(next.status, 200);
    assert.ok(h.calls.at(-1)!.context.observations.some(item => item.evidence === 'Completed: راجع مادة الامتحان'));
    const offered = ((await next.json()) as { suggestions: Array<{ title: string; status: string }> }).suggestions;
    assert.ok(!offered.some(item => item.title === 'راجع مادة الامتحان' && item.status === 'pending'));

    // 3. The other action is accepted and postponed: a postpone, not a failure.
    const project = pending.find(item => item.title === 'اعمل مشروع React صغير')!;
    const second = await decisionPost(req(`/api/mobile/intelligence/suggestions/${project.id}`, 'POST', { decision: 'accept' }), params(project.id));
    const projectId = ((await second.json()) as { suggestion: { linkedEntityId: string } }).suggestion.linkedEntityId;
    assert.equal((await act(projectId, 'postpone', { postponedUntil: later() })).status, 200);
    const afterPostpone = await outcomes(h.storage);
    const postponed = afterPostpone.find(item => item.sourceRef && item.evidence.includes('اعمل مشروع React صغير'))!;
    assert.equal(postponed.evidence, 'Postponed: اعمل مشروع React صغير');
    assert.doesNotMatch(postponed.evidence, /fail|miss/i);
    // Adding the same thing again is a new commitment, not a new outcome, and
    // leaves the recorded outcomes as they were.
    await seedCommitment('1a2b3c4d-0000-4000-8000-0000000000aa', 'اعمل مشروع React صغير');
    assert.equal((await inboxGet(req('/api/mobile/intelligence'))).status, 200);
    assert.deepEqual((await outcomes(h.storage)).map(item => item.id).sort(), afterPostpone.map(item => item.id).sort());
  } finally { h.restore(); }
});

test('E2E 5: with the loop switched off, the AI surfaces answer "unavailable" and the basics keep working', async () => {
  const h = begin();
  try {
    await grantPersonalization(h.storage);
    process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP = 'true';
    for (const response of [
      await inboxGet(req('/api/mobile/intelligence')),
      await generatePost(req('/api/mobile/intelligence/generate', 'POST', { trigger: 'visit' })),
    ]) {
      assert.equal(response.status, 404);
      // The shape the phone reads as "switched off" (FeatureUnavailableError), not as a failure.
      assert.deepEqual(await response.json(), { success: false, error: 'not found', reason: 'feature_unavailable' });
    }
    await seedCommitment(ID_DONE, 'Call the clinic');
    assert.equal((await act(ID_DONE, 'complete')).status, 200);
    assert.equal(h.calls.length, 0);
    assert.equal((await outcomes(h.storage)).length, 0);
  } finally { h.restore(); }
});
