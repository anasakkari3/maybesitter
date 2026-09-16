/**
 * The mobile client's contract, taken from the routes themselves.
 *
 * UC-1.R4 (#157) needs Zod schemas for every `/api/mobile` call the React
 * Native app makes. Written by hand from the issue's tables, those schemas
 * would be a second, drifting description of the backend — and the issue's own
 * tables are already stale in places (the next-step decision takes a whole
 * `proposal` object, not a bare `proposalId`).
 *
 * So this file does not describe the contract. It *invokes* each route handler
 * in-process, exactly as `mobileApiRoutes.test.ts` does, and writes what comes
 * back to `mobile/src/api/__fixtures__/*.json`. The RN Jest suite then parses
 * every fixture with the schema the app ships. A backend change that alters a
 * response makes this file rewrite a fixture, and the mobile suite fails until
 * the schema follows — which is the only way schema drift can be caught by CI
 * rather than by a user.
 *
 * It asserts as well as writes: a fixture that came back empty, or from an
 * error path, would otherwise be recorded as the contract.
 *
 * ── Why the values are normalised ────────────────────────────────
 *
 * Every response carries a fresh uuid and a `new Date()`, so a raw dump
 * rewrites all nineteen files on every run. That would make the diff pure
 * noise and hide the one thing this file exists to surface: a *shape* that
 * changed. `stabilise` replaces ids and instants with deterministic stand-ins
 * of the same form, so a fixture only changes when the contract does.
 *
 * Nothing here changes backend behaviour. It only reads it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeModule from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { setRecommendationConsent } from '../../lib/consents/recommendationConsentService.ts';
import { createStorageFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { persistParticipantState, readParticipantState } from '../../lib/services/mobile/participantState.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { POST as clarifyPost } from '../../src/app/api/mobile/capture/clarify/route.ts';
import { POST as sharePost } from '../../src/app/api/mobile/capture/share/route.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';
import {
  DELETE as commitmentDelete,
  GET as commitmentGet,
  PATCH as commitmentPatch,
} from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';
import { commitmentValidator } from '../../lib/services/mobile/commitmentValidator.ts';
import { GET as activityGet } from '../../src/app/api/mobile/activity/route.ts';
import { GET as activitySummaryGet } from '../../src/app/api/mobile/activity/summary/route.ts';
import { GET as nextStepGet } from '../../src/app/api/mobile/recommendations/next-step/route.ts';
import { POST as nextStepActionPost } from '../../src/app/api/mobile/recommendations/next-step/actions/route.ts';
import { GET as trustGet, POST as trustPost } from '../../src/app/api/mobile/pilot/trust/route.ts';
import { GET as feedbackHistoryGet } from '../../src/app/api/mobile/feedback/history/route.ts';
import { POST as feedbackRevokePost } from '../../src/app/api/mobile/feedback/[id]/revoke/route.ts';
import { POST as alphaFeedbackPost } from '../../src/app/api/mobile/alpha/feedback/route.ts';
import { POST as analyticsPost } from '../../src/app/api/mobile/analytics/route.ts';
import { GET as consentsGet } from '../../src/app/api/mobile/consents/route.ts';
import { PUT as aiConsentPut } from '../../src/app/api/mobile/consents/ai-processing/route.ts';
import { PUT as recommendationConsentPut } from '../../src/app/api/mobile/consents/recommendations/route.ts';
import { GET as profileGet } from '../../src/app/api/mobile/profile/route.ts';
import { PUT as routinePut } from '../../src/app/api/mobile/profile/routine/route.ts';
import { POST as describePost } from '../../src/app/api/mobile/profile/describe/route.ts';
import { POST as describeConfirmPost } from '../../src/app/api/mobile/profile/describe/confirm/route.ts';
import {
  DELETE as memoryDeleteAll,
  GET as memoryGet,
  POST as memoryPost,
} from '../../src/app/api/mobile/memory/route.ts';
import {
  DELETE as memoryDelete,
  PATCH as memoryPatch,
} from '../../src/app/api/mobile/memory/[id]/route.ts';
import {
  AI_CONSENT_VERSION,
  RECOMMENDATION_CONSENT_VERSION,
} from '../../src/contracts/v1/consentContracts.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { POST as planActionPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';
import { POST as planRegeneratePost } from '../../src/app/api/mobile/plans/[date]/regenerate/route.ts';
import { GET as planSettingsGet, PUT as planSettingsPut } from '../../src/app/api/mobile/settings/plan/route.ts';
import { GET as calendarSettingsGet, PUT as calendarSettingsPut } from '../../src/app/api/mobile/settings/calendar/route.ts';
import {
  DELETE as calendarLinkDelete,
  PUT as calendarLinkPut,
} from '../../src/app/api/mobile/commitments/[id]/device-calendar-link/route.ts';
import {
  DELETE as calendarBusyDelete,
  POST as calendarBusyPost,
} from '../../src/app/api/mobile/calendar/busy/route.ts';
import { busyBlockId } from '../../lib/calendar/busyBlocks.ts';
import { resetProviderForTests } from '../../src/extraction/llm/index.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';

const BASE = 'http://127.0.0.1:4321';
const REFERENCE_TIME = '2026-08-09T08:00:00.000Z';

/**
 * The due date the PATCH fixture is recorded with (#352).
 *
 * Every other time here is handed to a route as `referenceTime`, so a literal
 * is safe. PATCH reads the real clock and refuses a past `dueDate`, so this
 * one is an offset from a reference taken at load. `stabilise` rewrites it to
 * `STABLE_INSTANT` before it is written, so the recorded contract stays
 * byte-identical between runs — a clock-relative input, a deterministic file.
 */
const WALL_CLOCK = new Date();
const PATCHED_DUE_DATE = new Date(WALL_CLOCK.getTime() + 72 * 3_600_000).toISOString();
const USER = uidFor('FixtureUser');

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'mobile',
  'src',
  'api',
  '__fixtures__',
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID = /^(next-step|fbk|incident|flag)[-_][0-9a-f]+$/i;
/** `mem_<uuid>` — a runtime memory id (#167). Keeps its prefix and its shape. */
const MEMORY_ID = /^mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const STABLE_INSTANT = '2026-08-09T09:00:00.000Z';
/**
 * A plan's `inputDigest` (#194): sha256 hex over the planning request, so it
 * moves with the capture's random commitment ids and would otherwise rewrite
 * the plan fixtures on every run.
 */
const DIGEST = /^[0-9a-f]{64}$/;
const STABLE_DIGEST = '0'.repeat(64);

/**
 * Replaces the values that differ between two identical runs, and only those.
 * An id keeps its shape — a uuid stays uuid-shaped — because the schemas and
 * the client both treat shape as part of the contract.
 */
function stabilise(value: unknown, counters: Map<string, number>): unknown {
  if (Array.isArray(value)) return value.map(item => stabilise(item, counters));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, stabilise(item, counters)]),
    );
  }
  if (typeof value !== 'string') return value;
  if (INSTANT.test(value)) return value === REFERENCE_TIME ? value : STABLE_INSTANT;
  if (DIGEST.test(value)) return STABLE_DIGEST;
  if (MEMORY_ID.test(value)) return `mem_${stableId('00000000-0000-4000-8000-', 12, counters)}`;
  if (UUID.test(value)) return stableId('00000000-0000-4000-8000-', 12, counters);
  const prefixed = PREFIXED_ID.exec(value);
  if (prefixed) return `${prefixed[1]}${value.includes('_') ? '_' : '-'}${'0'.repeat(16)}`;
  return value;
}

/** A uuid-shaped id that is the same on every run, and unique within a run. */
function stableId(prefix: string, width: number, counters: Map<string, number>): string {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return `${prefix}${String(next).padStart(width, '0')}`;
}

function request(path: string, options: { method?: string; body?: unknown; uid?: string } = {}): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(options.uid ?? USER)}` });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function dateParams(date: string): { params: Promise<{ date: string }> } {
  return { params: Promise.resolve({ date }) };
}

/**
 * The one route that does not take JSON (UC-3.0, #183).
 *
 * Built here rather than with `request()` so the fixture is generated from a
 * real `multipart/form-data` body — the same thing `apiUpload` sends — instead
 * of from a shape this file invented.
 */
function shareRequest(text: string): Request {
  const form = new FormData();
  form.set('text', text);
  form.set('timezone', 'Asia/Jerusalem');
  form.set('referenceTime', REFERENCE_TIME);
  form.set('sourceHint', 'unknown');
  return new Request(`${BASE}/api/mobile/capture/share`, {
    method: 'POST',
    headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}` }),
    body: form,
  });
}

/**
 * Records one response as a fixture, after checking it is the response the
 * client will actually see. A 500 written to disk would be a schema the app
 * then validates against forever.
 */
async function record(name: string, expectedStatus: number, response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(
    response.status,
    expectedStatus,
    `${name}: expected ${expectedStatus}, got ${response.status} — ${JSON.stringify(body)}`,
  );
  const stable = stabilise(body, new Map());
  writeFileSync(join(FIXTURES, `${name}.json`), `${JSON.stringify(stable, null, 2)}\n`, 'utf8');
  // The live body is returned, not the normalised one: the rest of this test
  // chains real ids into the next call.
  return body;
}

function setup(): () => void {
  const directory = mkdtempSync(join(tmpdir(), 'maybesitter-fixtures-'));
  const previous: Record<string, string | undefined> = {
    MAYBESITTER_DATA_DIR: process.env.MAYBESITTER_DATA_DIR,
    MAYBESITTER_FEATURE_RECOMMENDATION: process.env.MAYBESITTER_FEATURE_RECOMMENDATION,
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION,
    MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS: process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS,
    MAYBESITTER_ALPHA_FEEDBACK_ENABLED: process.env.MAYBESITTER_ALPHA_FEEDBACK_ENABLED,
    MAYBESITTER_FEATURE_MEMORY: process.env.MAYBESITTER_FEATURE_MEMORY,
    MAYBESITTER_FEATURE_PRIORITY: process.env.MAYBESITTER_FEATURE_PRIORITY,
    MAYBESITTER_KILL_SWITCH_MEMORY: process.env.MAYBESITTER_KILL_SWITCH_MEMORY,
    SHARE_INTAKE_ENABLED: process.env.SHARE_INTAKE_ENABLED,
  };
  process.env.MAYBESITTER_DATA_DIR = directory;
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS = 'true';
  process.env.MAYBESITTER_ALPHA_FEEDBACK_ENABLED = 'true';
  process.env.MAYBESITTER_FEATURE_MEMORY = 'true';
  // On, so the fixtures carry `rank` and `reasonCodes` and the client
  // schema is checked against a response that has them (#169).
  process.env.MAYBESITTER_FEATURE_PRIORITY = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_MEMORY = 'false';
  // On, so the share fixture is the shape the client parses when the feature is
  // available. Its 404 shape is `errors.unauthorized`-style and needs no fixture
  // of its own: the client treats a 404 as "this build has no share route".
  process.env.SHARE_INTAKE_ENABLED = 'true';
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  setStorageForTests(createMemoryStorage());
  mkdirSync(FIXTURES, { recursive: true });
  const auth: FakeAuthControls = installFakeAuth();
  return () => {
    auth.restore();
    resetStorageForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  };
}


/**
 * ── The Gemini fixture, without a Gemini bill (#338) ─────────────
 *
 * `provenance.executedEngine` is a `z.enum(['gemini','ollama','rule-based'])`
 * on the client. Every fixture recorded above says `rule-based`, because no
 * model is configured in this suite — so the enum had nothing to be wrong
 * about, and a client that dropped the Gemini case would have gone unnoticed.
 *
 * The honest way to record the Gemini shape is to run the real route with a
 * real Gemini provider. #330 is the paid run that does that; it has not
 * happened, and a hand-written JSON file would be a second description of the
 * contract — exactly what this whole file exists to avoid.
 *
 * So everything runs except the network. The stub below replaces the
 * `@google/genai` SDK module — the last hop, the one `geminiProvider.ts`
 * reaches by `await import()` — and nothing else. The capture route, the
 * consent gate, the cost guard, the call log, the prompt split, the provider's
 * own response handling, the schema validator, the capture boundary and the
 * proposal store all execute for real, and `llmEngine: 'gemini'` is decided by
 * `configuredProviderName()` reading the environment, not by this file saying
 * so. What is recorded is what the handler returns.
 *
 * The one thing it cannot prove is that Gemini itself answers in this shape.
 * That is #330's job, and it is why the payload is the extractor's documented
 * schema rather than something invented for the occasion.
 */
const GENAI_STUB_URL = 'maybesitter-fixture:google-genai';

/**
 * The SDK surface `resolveGenerate` touches, and no more: a constructor and
 * `models.generateContent`. The answer comes from a global so this module's
 * source stays a constant while the payload stays readable below.
 */
const GENAI_STUB_SOURCE = `
export class GoogleGenAI {
  constructor(options) {
    this.options = options;
    globalThis.__maybesitterVertexClientOptions = options;
  }
  get models() {
    return { generateContent: async (input) => globalThis.__maybesitterVertexGenerate(input) };
  }
}
`;

type VertexStub = (input: { model: string; contents: unknown; config: Record<string, unknown> }) => Promise<{
  text?: string;
  modelVersion?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}>;

type StubGlobals = typeof globalThis & {
  __maybesitterVertexGenerate?: VertexStub;
  __maybesitterVertexClientOptions?: { location?: string };
};

/**
 * `module.registerHooks`, typed here because `@types/node` is still on 20 while
 * this repository runs on Node 24. Declaring the two hooks it uses is a smaller
 * change than bumping the types of every file for one test, and it is checked:
 * the call below is the real one, so a signature that stopped matching fails at
 * runtime rather than silently.
 */
interface SyncModuleHooks {
  resolve(specifier: string, context: unknown, nextResolve: (specifier: string, context: unknown) => unknown): unknown;
  load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown): unknown;
}
const registerHooks = (nodeModule as unknown as {
  registerHooks(hooks: SyncModuleHooks): { deregister(): void };
}).registerHooks;

/** Redirects `@google/genai`, and only that specifier, to the stub above. */
function installVertexStub(generate: VertexStub): () => void {
  (globalThis as StubGlobals).__maybesitterVertexGenerate = generate;
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
  return () => {
    hooks.deregister();
    delete (globalThis as StubGlobals).__maybesitterVertexGenerate;
  };
}

/**
 * What a Gemini extraction of "Call the dentist tomorrow at 3pm" looks like on
 * the wire, in the schema `ollamaExtractionSchema.ts` asks Vertex for.
 *
 * The instant is derived from the same `REFERENCE_TIME` the request carries,
 * not written as a bare literal: tomorrow, 15:00 in Asia/Jerusalem. `stabilise`
 * rewrites it before it is recorded, so the fixture on disk is the same bytes
 * on every run and on every day this is run (#382).
 */
function geminiExtraction(): string {
  const localDay = new Date(Date.parse(REFERENCE_TIME) + 86_400_000).toISOString().slice(0, 10);
  // Asia/Jerusalem is UTC+3 in August, so 15:00 local is 12:00Z.
  const instant = `${localDay}T12:00:00.000Z`;
  return JSON.stringify({
    type: 'task',
    action: 'Call the dentist',
    title: 'Call the dentist',
    person: null,
    dueAt: instant,
    remindAt: instant,
    localTimeSpec: { date: localDay, time: '15:00', timezone: 'Asia/Jerusalem' },
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    confidence: { overall: 0.94, type: 0.96, action: 0.95, time: 0.93, priority: 0.7 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
  });
}

test('exports a fixture for every /api/mobile call the React Native client makes', async () => {
  const teardown = setup();
  try {
    // ── capture → confirm ──────────────────────────────────────────
    const proposal = await record('capture.proposal', 200, await capturePost(request('/api/mobile/capture', {
      body: { text: 'Call the dentist tomorrow at 3pm', referenceTime: REFERENCE_TIME, timezone: 'Asia/Jerusalem' },
    })));
    assert.equal(proposal.status, 'proposed');
    const items = proposal.items as Array<{ itemId: string }>;
    assert.ok(items.length > 0, 'the proposal must carry at least one item');

    const confirmation = await record('capture.confirmation', 200, await confirmPost(request('/api/mobile/capture/confirm', {
      body: { proposalId: proposal.proposalId, itemIds: [items[0]!.itemId] },
    })));
    assert.equal(confirmation.success, true);
    const persisted = confirmation.persisted as Array<{ commitmentId: string }>;
    const commitmentId = persisted[0]!.commitmentId;

    // ── the one clarification (#165) ───────────────────────────────
    // A capture with an action and no time: the extractor cannot resolve it,
    // so the proposal carries a question and the app has a real shape to
    // render from keys.
    const ambiguous = await record('capture.needsClarification', 200, await capturePost(request('/api/mobile/capture', {
      body: { text: 'Remind me to call Dana', referenceTime: REFERENCE_TIME, timezone: 'Asia/Jerusalem' },
    })));
    const asking = (ambiguous.items as Array<{ itemId: string; clarification: { questionId: string; options: Array<{ optionId: string }> } | null }>)
      .find((item) => item.clarification);
    assert.ok(asking, 'expected an item carrying a clarification');
    await record('capture.clarified', 200, await clarifyPost(request('/api/mobile/capture/clarify', {
      body: {
        proposalId: ambiguous.proposalId,
        itemId: asking.itemId,
        questionId: asking.clarification!.questionId,
        optionId: asking.clarification!.options[0]!.optionId,
        referenceTime: REFERENCE_TIME,
        timezone: 'Asia/Jerusalem',
      },
    })));

    // ── share intake (UC-3.0, #183) ────────────────────────────────
    // The same proposal shape as `capture.proposal`, plus the `share`
    // envelope. Generated from a real multipart body.
    const shared = await record('capture.shareProposal', 200, await sharePost(
      shareRequest('Call the dentist tomorrow at 3pm'),
    ));
    assert.equal(shared.status, 'proposed');
    assert.ok(Array.isArray(shared.items) && (shared.items as unknown[]).length > 0);
    const envelope = shared.share as {
      channel?: string;
      totalBytes?: number;
      evidence?: Array<{ itemId: string; sourceIndex: number | null; excerpt: string }>;
      evidenceDropped?: boolean;
      metrics?: Record<string, number>;
    };
    assert.equal(envelope.channel, 'plain-text');
    assert.equal(envelope.totalBytes, 0);
    // The evidence four lanes build on, generated by the real handler rather
    // than written into a fixture by hand: one entry per item, naming an item
    // that is actually in the proposal, `sourceIndex` null because this share
    // was text rather than a file (#183 step 7f).
    assert.equal(envelope.evidenceDropped, false);
    assert.equal(envelope.evidence?.length, (shared.items as unknown[]).length);
    assert.equal(envelope.evidence?.[0]?.sourceIndex, null);
    assert.ok((envelope.evidence?.[0]?.excerpt ?? '').length > 0);
    assert.ok((envelope.evidence?.[0]?.excerpt ?? '').length <= 140);
    // Numbers only, and actually populated — the field used to be dead.
    assert.ok(Object.values(envelope.metrics ?? {}).every((value) => typeof value === 'number'));
    assert.equal(envelope.metrics?.textSegments, 1);

    // The failure shape the client has to read since #252: a confirm that
    // persisted nothing answers 404, not 200, and names the items it refused.
    await record('capture.confirmationFailed', 404, await confirmPost(request('/api/mobile/capture/confirm', {
      body: { proposalId: 'proposal-that-does-not-exist', itemIds: ['item-1'] },
    })));

    // ── commitments ────────────────────────────────────────────────
    const today = await record('commitments.today', 200, await todayGet(
      request(`/api/mobile/commitments/today?referenceTime=${REFERENCE_TIME}&timezone=Asia%2FJerusalem`),
    ));
    assert.ok(Array.isArray(today.items));

    await record('commitments.upcoming', 200, await upcomingGet(
      request(`/api/mobile/commitments/upcoming?referenceTime=${REFERENCE_TIME}&timezone=Asia%2FJerusalem`),
    ));

    await record('commitments.one', 200, await commitmentGet(
      request(`/api/mobile/commitments/${commitmentId}`),
      params(commitmentId),
    ));

    await record('commitments.patched', 200, await commitmentPatch(
      new Request(`${BASE}/api/mobile/commitments/${commitmentId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Call the dentist', dueDate: PATCHED_DUE_DATE }),
      }),
      params(commitmentId),
    ));

    await record('commitments.action', 200, await actionPost(
      request(`/api/mobile/commitments/${commitmentId}/actions`, { body: { action: 'complete' } }),
      params(commitmentId),
    ));

    // ── the device calendar (UC-3.1, #185) ─────────────────────────
    // Recorded in the order the app performs them: claim the link, read the
    // commitment back with it attached, watch a second installation be refused,
    // then forget it. `commitments.one` above is the same read with no link, so
    // both halves of the nullable field are a fixture rather than a belief.
    await record('calendar.settingsDefault', 200, await calendarSettingsGet(
      request('/api/mobile/settings/calendar'),
    ));
    await record('calendar.settingsSaved', 200, await calendarSettingsPut(
      request('/api/mobile/settings/calendar', { method: 'PUT', body: { writeTarget: 'device' } }),
    ));

    await record('calendar.linkStored', 200, await calendarLinkPut(
      request(`/api/mobile/commitments/${commitmentId}/device-calendar-link`, {
        method: 'PUT',
        body: {
          writerId: 'writer-phone',
          calendarId: 'calendar-1',
          eventId: 'event-1',
          contentHash: 'b1946ac92492d2347c6235b4d2611184',
          state: 'linked',
        },
      }),
      params(commitmentId),
    ));

    await record('commitments.oneLinked', 200, await commitmentGet(
      request(`/api/mobile/commitments/${commitmentId}`),
      params(commitmentId),
    ));

    await record('calendar.linkConflict', 409, await calendarLinkPut(
      request(`/api/mobile/commitments/${commitmentId}/device-calendar-link`, {
        method: 'PUT',
        body: {
          writerId: 'writer-tablet',
          calendarId: 'calendar-2',
          eventId: 'event-2',
          contentHash: 'b1946ac92492d2347c6235b4d2611184',
          state: 'linked',
        },
      }),
      params(commitmentId),
    ));

    await record('calendar.linkRemoved', 200, await calendarLinkDelete(
      request(`/api/mobile/commitments/${commitmentId}/device-calendar-link?writerId=writer-phone`, {
        method: 'DELETE',
      }),
      params(commitmentId),
    ));

    // ── busy time (UC-3.2, #186) ───────────────────────────────────
    // The one route somebody's calendar travels over. Recorded with two blocks
    // — one timed, one all-day — and then disconnected, so both the stored and
    // the deleted shape are a fixture the app's schemas are parsed against.
    // Note what is *not* in the response: no block, no id, nothing the user
    // would recognise. An echo would be the only place in this feature where
    // busy intervals came back over the network.
    // The trust store refuses a backdated action, so these two carry the wall
    // clock rather than the fixture's reference time. Nothing recorded below
    // depends on either value.
    const trustAt = new Date().toISOString();
    await applyTrustAction(USER, { type: 'record_first_value', at: trustAt });
    await applyTrustAction(USER, { type: 'set_calendar_consent', granted: true, at: trustAt });

    const busySource = 'device:writer-phone';
    await record('calendar.busyStored', 200, await calendarBusyPost(
      request('/api/mobile/calendar/busy', {
        body: {
          sourceId: busySource,
          platform: 'ios',
          windowStart: '2026-08-09T00:00:00.000Z',
          windowEnd: '2026-09-06T00:00:00.000Z',
          blocks: [
            {
              blockId: busyBlockId(busySource, 'event-lecture', '2026-08-10T07:00:00.000Z'),
              startAt: '2026-08-10T07:00:00.000Z',
              endAt: '2026-08-10T09:00:00.000Z',
              allDay: false,
            },
            {
              blockId: busyBlockId(busySource, 'event-holiday', '2026-08-12T00:00:00.000Z'),
              startAt: '2026-08-12T00:00:00.000Z',
              endAt: '2026-08-13T00:00:00.000Z',
              allDay: true,
            },
          ],
        },
      }),
    ));

    await record('calendar.busyDeleted', 200, await calendarBusyDelete(
      request(`/api/mobile/calendar/busy?sourceId=${encodeURIComponent(busySource)}`, { method: 'DELETE' }),
    ));
    // And switched back off, which is what "disconnect" means for the account
    // as well as for the phone. It also leaves the trust fixtures recorded
    // below saying what they said before this section existed: the calendar
    // consent they carry is the *unconsented* shape, which is the one the
    // Trust Center renders for everybody who has never turned it on.
    await applyTrustAction(USER, { type: 'set_calendar_consent', granted: false, at: new Date().toISOString() });

    // ── activity (#201) ────────────────────────────────────────────
    // Read here, after the complete above, so the log already holds a
    // captured / confirmed / completed entry for a real commitment.
    const activity = await record('activity.list', 200, await activityGet(
      request('/api/mobile/activity?limit=50'),
    ));
    assert.ok(Array.isArray(activity.items) && (activity.items as unknown[]).length > 0,
      'the activity fixture must carry at least one entry');

    /*
     * A fixed `weekStart`, and deliberately one with nothing in it.
     *
     * The counts have to be the same on every run, and every event above is
     * stamped with the real clock — so any week that contained them would
     * change with the calendar. This is also the state #201 cares most about
     * the client rendering: a quiet week, with the Moments still there.
     */
    const summary = await record('activity.summary', 200, await activitySummaryGet(
      request('/api/mobile/activity/summary?weekStart=2026-08-09'),
    ));
    assert.equal(summary.completedCount, 0);
    assert.ok(Array.isArray(summary.moments) && (summary.moments as unknown[]).length > 0,
      'the Moments come from the counter and must survive a week with nothing in it');

    await record('commitments.notFound', 404, await commitmentGet(
      request('/api/mobile/commitments/not-a-real-commitment'),
      params('not-a-real-commitment'),
    ));

    // ── the optimistic-concurrency refusals (#148) ──────────────────
    // A second device's stale edit. The client has to be able to render the
    // newer commitment, which is why `current` is in the body.
    const stale = await commitmentPatch(
      new Request(`${BASE}/api/mobile/commitments/${commitmentId}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${tokenFor(USER)}`,
          'content-type': 'application/json',
          'if-match': '"1999-01-01T00:00:00.000Z"',
        },
        body: JSON.stringify({ title: 'An edit from a screen that had gone stale' }),
      }),
      params(commitmentId),
    );
    await record('commitments.stale', 409, stale);


    // ── trust ──────────────────────────────────────────────────────
    const trust = await record('trust.state', 200, await trustGet(request('/api/mobile/pilot/trust')));
    assert.equal(trust.success, true);

    await record('trust.updated', 200, await trustPost(request('/api/mobile/pilot/trust', {
      body: { action: { type: 'set_analytics_consent', granted: true } },
    })));

    // ── next step ──────────────────────────────────────────────────
    // Needs a confirmed commitment and recommendation consent, or the route
    // answers a blocked state rather than the shape the client renders.
    const second = await capturePost(request('/api/mobile/capture', {
      body: { text: 'Send the report to Sami on Thursday at 10am', referenceTime: REFERENCE_TIME, timezone: 'Asia/Jerusalem' },
    }));
    const secondProposal = await second.json() as { proposalId: string; items: Array<{ itemId: string }> };
    await confirmPost(request('/api/mobile/capture/confirm', {
      body: { proposalId: secondProposal.proposalId, itemIds: [secondProposal.items[0]!.itemId] },
    }));
    // Both consent reads happen here, before anything is granted.
    //
    // They exist to capture the shape a fresh account sees — declined, and
    // `asked: false` — and the next-step fixtures below need the launch consent
    // granted (#170). One fixture user cannot be both, so the order decides:
    // read the untouched state first, then consent.
    //
    // `consents.view` is the composer's "AI: off" chip (UC-2.R2 #172 step 4),
    // which has to get "never asked" right because it must not read as a
    // decision. `consents.unanswered` is the same shape for #161's schema.
    await record('consents.view', 200, await consentsGet(request('/api/mobile/consents')));
    await record('consents.unanswered', 200, await consentsGet(request('/api/mobile/consents')));

    await applyTrustAction(USER, { type: 'grant_recommendation_consent', at: new Date().toISOString() });
    // The launch consent too: onboarding writes this one, and since #170 it is
    // what the next step reads. Without it the fixture user is refused.
    await setRecommendationConsent(USER, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });

    const nextStep = await record('nextStep.recommendation', 200, await nextStepGet(
      request('/api/mobile/recommendations/next-step?locale=en'),
    ));
    const recommendation = nextStep.recommendation as { state: string; proposalId: string };
    assert.equal(recommendation.state, 'ready', 'the fixture must capture a ready recommendation');

    // The whole proposal object, echoed. Sending a bare proposalId is the
    // regression this fixture exists to make impossible.
    await record('nextStep.decision', 200, await nextStepActionPost(request('/api/mobile/recommendations/next-step/actions', {
      body: { locale: 'en', decision: 'accept', proposal: recommendation, idempotencyKey: 'fixture-key-1' },
    })));

    // ── feedback history ───────────────────────────────────────────
    const history = await feedbackHistoryGet(request('/api/mobile/feedback/history')).then(r => r.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(history.rows), 'history must answer with a rows array');

    // The mobile commitment routes do not themselves write behaviour events —
    // `agendaActionService` does, from the web agenda — so an event is appended
    // through the same store the route reads, purely to capture what a
    // populated history and a successful revoke look like on the wire. This
    // writes a row for this test's throwaway uid; it changes no behaviour.
    const seeded = await createStorageFeedbackEventStore().append(
      {
        scopeId: USER,
        outcome: 'complete',
        subjectId: commitmentId,
        actor: 'user',
        source: 'mobile_action',
        occurredAt: REFERENCE_TIME,
      },
      REFERENCE_TIME,
    );
    const populated = await record('feedback.history', 200, await feedbackHistoryGet(
      request('/api/mobile/feedback/history'),
    ));
    const rows = populated.rows as Array<{ id: string }>;
    assert.ok(rows.length > 0, 'the seeded event must be visible in history');

    await record('feedback.revoked', 200, await feedbackRevokePost(
      request(`/api/mobile/feedback/${seeded.id}/revoke`, { body: {} }),
      params(seeded.id),
    ));

    // ── alpha feedback ─────────────────────────────────────────────
    await record('alphaFeedback.flag', 201, await alphaFeedbackPost(request('/api/mobile/alpha/feedback', {
      body: { proposalId: recommendation.proposalId, category: 'not_useful', note: 'fixture note' },
    })));

    // ── analytics ──────────────────────────────────────────────────
    // `{ eventName, properties }`, not the Flutter `PilotLoopAnalyticsEvent`
    // shape #157's table names: the route validates `eventName` against
    // CLIENT_REPORTABLE_EVENTS and reads nothing else from the body.
    await record('analytics.ack', 200, await analyticsPost(request('/api/mobile/analytics', {
      // Each event name has its own allowed property list
      // (`EVENT_PROPERTIES` in lib/analytics/privacySafeEvents.ts); anything
      // else is refused, which is how raw content is kept out of analytics.
      body: { eventName: 'reason_opened', properties: { proposalId: recommendation.proposalId } },
    })));

    // ── the delete shape, last: it changes the commitment ──────────
    await record('commitments.deleted', 200, await commitmentDelete(
      new Request(`${BASE}/api/mobile/commitments/${commitmentId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tokenFor(USER)}` },
      }),
      params(commitmentId),
    ));

    // The state machine refusing the move — a different 409, and a different
    // thing to tell the user. Postponing a commitment that has been dropped;
    // completing an already-completed one is idempotent and answers 200.
    await record('commitments.invalidTransition', 409, await actionPost(
      request(`/api/mobile/commitments/${commitmentId}/actions`, {
        // Genuinely in the future: `postponeCommitment` refuses a past
        // instant with a 400 before the state machine ever sees the move.
        body: { action: 'postpone', postponedUntil: new Date(Date.now() + 86_400_000).toISOString() },
      }),
      params(commitmentId),
    ));

    // ── consents (#161, #170) ──────────────────────────────────────
    await record('consents.aiRecorded', 200, await aiConsentPut(request('/api/mobile/consents/ai-processing', {
      method: 'PUT',
      body: { state: 'granted', version: AI_CONSENT_VERSION, locale: 'ar', platform: 'ios' },
    })));

    await record('consents.recommendationsRecorded', 200, await recommendationConsentPut(
      request('/api/mobile/consents/recommendations', {
        method: 'PUT',
        body: { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION, locale: 'ar', platform: 'ios' },
      }),
    ));

    await record('consents.answered', 200, await consentsGet(request('/api/mobile/consents')));

    // The refusal the onboarding screen has to be able to render: a version
    // this server does not know is not consent to anything.
    await record('consents.unsupportedVersion', 400, await recommendationConsentPut(
      request('/api/mobile/consents/recommendations', {
        method: 'PUT',
        body: { state: 'granted', version: 'rec-consent-v99' },
      }),
    ));

    // ── the routine profile and memory (#167) ──────────────────────
    await record('profile.empty', 200, await profileGet(request('/api/mobile/profile')));

    await record('profile.saved', 200, await routinePut(request('/api/mobile/profile/routine', {
      method: 'PUT',
      body: {
        timezone: 'Asia/Jerusalem',
        sleepWindow: { start: '23:30', end: '07:30' },
        focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
        fixedCommitmentWindows: [],
        preferredReminderIntensity: 'followUp',
        quietHours: { start: '22:30', end: '07:30' },
        surveySkipped: false,
      },
    })));

    await record('profile.one', 200, await profileGet(request('/api/mobile/profile')));

    // ── the self-description pair (#168) ───────────────────────────
    // No model is configured here, so the suggestion list comes back empty —
    // which is the shape the client must handle anyway, and the honest record
    // of what this handler returns without one.
    const described = await record('profile.described', 200, await describePost(request('/api/mobile/profile/describe', {
      body: { text: 'I am a nursing student and my thesis is due in March.' },
    })));

    await record('profile.describeConfirmed', 200, await describeConfirmPost(
      request('/api/mobile/profile/describe/confirm', {
        body: { proposalId: (described as { proposalId: string }).proposalId, accepted: [] },
      }),
    ));

    // The refusal the review screen has to render: a proposal that expired
    // while the user was reading it.
    await record('profile.describeExpired', 404, await describeConfirmPost(
      request('/api/mobile/profile/describe/confirm', {
        body: { proposalId: 'not-a-real-proposal', accepted: [] },
      }),
    ));

    // The survey's own facts, each with the provenance chip the screen renders.
    await record('memory.list', 200, await memoryGet(request('/api/mobile/memory')));

    const manual = await record('memory.created', 201, await memoryPost(request('/api/mobile/memory', {
      body: { kind: 'goal', content: 'Finish the thesis by March', language: 'en' },
    })));
    const manualId = (manual.memory as { id: string }).id;

    await record('memory.patched', 200, await memoryPatch(
      new Request(`${BASE}/api/mobile/memory/${manualId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Finish the thesis by April' }),
      }),
      params(manualId),
    ));

    const patchedId = ((await (await memoryGet(request('/api/mobile/memory'))).json() as {
      items: Array<{ id: string; content: string }>;
    }).items.find(item => item.content.includes('April'))!).id;

    await record('memory.deleted', 200, await memoryDelete(
      new Request(`${BASE}/api/mobile/memory/${patchedId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tokenFor(USER)}` },
      }),
      params(patchedId),
    ));

    await record('memory.notFound', 404, await memoryDelete(
      new Request(`${BASE}/api/mobile/memory/mem_00000000-0000-4000-8000-000000000000`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tokenFor(USER)}` },
      }),
      params('mem_00000000-0000-4000-8000-000000000000'),
    ));

    await record('memory.deletedAll', 200, await memoryDeleteAll(
      new Request(`${BASE}/api/mobile/memory`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tokenFor(USER)}` },
      }),
    ));

    // ── the daily plan (#194), rendered by UC-3.10b (#195) ─────────
    // The settings pair first: `nextRunAt` is the server's own answer to "when
    // does my next plan arrive", which the screen shows rather than recomputing
    // a DST boundary on the phone.
    await record('plan.settingsDefault', 200, await planSettingsGet(request('/api/mobile/settings/plan')));
    await record('plan.settingsSaved', 200, await planSettingsPut(request('/api/mobile/settings/plan', {
      method: 'PUT',
      body: { enabled: true, deliveryLocalTime: '07:30' },
    })));

    // A real plan, built the way the morning job builds one: arm the delivery,
    // claim it, build it. No model is configured in this suite, so the
    // explanation is the deterministic template — which is also the shape the
    // client sees whenever a model call falls back.
    const PLAN_DATE = '2026-08-09';

    // Three undated commitments, written straight into the account's domain
    // state, purely so the plan below has something to place. The capture flow
    // above leaves this user with one dated commitment and one deleted one, and
    // a fixture whose `scheduled` array is empty would never exercise the item
    // schema the plan screen (#195) parses. Nothing about the backend changes;
    // this only gives the recorded response something to be about.
    const seedState = ['Write the summary', 'Call the bank', 'Book the train'].reduce(
      (state, title, index) => {
        const id = `plan_fixture_${index}`;
        const drafted = applyDomainCommand(state, {
          type: 'CreateDraft',
          now: REFERENCE_TIME,
          commitment: { id, kind: 'task', title, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: 'Asia/Jerusalem' } },
          draftStatus: 'pending_confirmation',
        }).newState;
        return applyDomainCommand(drafted, { type: 'ConfirmCommitment', commitmentId: id, now: REFERENCE_TIME, reminders: [] }).newState;
      },
      await readParticipantState(USER),
    );
    await persistParticipantState(USER, seedState);

    await savePlanSettings(USER, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-08-08T12:00:00.000Z'));
    const claim = await claimDueDelivery(USER, new Date('2026-08-09T06:00:00.000Z'));
    assert.ok(claim, 'the fixture user was not due for a plan');
    assert.equal(claim.date, PLAN_DATE);
    await buildAndStoreDailyPlan(claim, { now: () => new Date(REFERENCE_TIME) });

    const plan = await record('plan.today', 200, await planGet(request(`/api/mobile/plans/${PLAN_DATE}`), dateParams(PLAN_DATE)));
    assert.ok(
      ((plan.plan as { scheduled: unknown[] }).scheduled).length > 0,
      'the plan fixture placed nothing, so the item schema it exists to pin is never exercised',
    );

    await record('plan.accepted', 200, await planActionPost(
      request(`/api/mobile/plans/${PLAN_DATE}/actions`, { body: { action: 'accept' } }),
      dateParams(PLAN_DATE),
    ));

    // The 422 the plan screen has to render next to the item the user dragged:
    // a reason code and the item it is about, not a sentence.
    await record('plan.editRejected', 422, await planActionPost(
      request(`/api/mobile/plans/${PLAN_DATE}/actions`, {
        body: { action: 'edit', moves: [{ itemId: 'not-in-this-plan', startsAt: '2026-08-09T09:00:00.000Z' }] },
      }),
      dateParams(PLAN_DATE),
    ));

    await record('plan.regenerated', 200, await planRegeneratePost(
      request(`/api/mobile/plans/${PLAN_DATE}/regenerate`, { body: {} }),
      dateParams(PLAN_DATE),
    ));

    await record('plan.notFound', 404, await planGet(
      request('/api/mobile/plans/2026-08-10'),
      dateParams('2026-08-10'),
    ));

    // ── the refusals every screen must be able to render ───────────
    const unauthenticated = await commitmentGet(
      new Request(`${BASE}/api/mobile/commitments/${commitmentId}`, { headers: new Headers() }),
      params(commitmentId),
    );
    await record('errors.unauthorized', 401, unauthenticated);

    // ── the Gemini capture (#160, #338) ────────────────────────────
    // Last, and with the environment restored straight afterwards, so every
    // fixture above is recorded by a server with no model configured — which
    // is what they all say, and what they have always said.
    //
    // AI consent was granted through the real route at `consents.aiRecorded`
    // above; without it `proposeMobileCapture` asks for rules and the engine
    // could never be `gemini` however the provider is configured.
    const previousProvider = process.env.MAYBESITTER_LLM_PROVIDER;
    const previousLocation = process.env.MAYBESITTER_VERTEX_LOCATION;
    let vertexCalls = 0;
    const removeStub = installVertexStub(async (input) => {
      vertexCalls += 1;
      // The prompt is split at BEGIN_UNTRUSTED_USER_MESSAGE before it gets
      // here. If that ever stops happening the rules travel as user content,
      // which is the #162 defect — so the stub refuses to answer a request
      // that arrives without a system instruction.
      assert.equal(
        typeof (input.config as { systemInstruction?: unknown }).systemInstruction,
        'string',
        'the capture prompt reached the provider without a system instruction',
      );
      return {
        text: geminiExtraction(),
        modelVersion: 'gemini-2.5-flash',
        usageMetadata: { promptTokenCount: 1180, candidatesTokenCount: 96 },
      };
    });
    process.env.MAYBESITTER_LLM_PROVIDER = 'gemini';
    process.env.MAYBESITTER_VERTEX_LOCATION = 'europe-west1';
    resetProviderForTests();
    try {
      const gemini = await record('capture.geminiProposal', 200, await capturePost(request('/api/mobile/capture', {
        body: { text: 'Call the dentist tomorrow at 3pm', referenceTime: REFERENCE_TIME, timezone: 'Asia/Jerusalem' },
      })));
      // Each of these can go red on its own, and each says something different.
      assert.equal(vertexCalls, 1, 'the capture never reached the provider');
      assert.equal(
        (globalThis as StubGlobals).__maybesitterVertexClientOptions?.location,
        'europe-west1',
        'the capture text was sent somewhere other than the region the consent screen names',
      );
      const provenance = gemini.provenance as { requestedEngine: string; executedEngine: string; fallbackUsed: boolean };
      assert.equal(provenance.requestedEngine, 'model');
      assert.equal(provenance.executedEngine, 'gemini', 'the model answered but provenance does not say so');
      assert.equal(provenance.fallbackUsed, false);
      assert.equal(gemini.status, 'proposed');
      const geminiItems = gemini.items as Array<{ title: string; resolvedTime: string | null }>;
      assert.equal(geminiItems.length, 1);
      assert.equal(geminiItems[0]!.title, 'Call the dentist');
      assert.ok(geminiItems[0]!.resolvedTime, 'a Gemini proposal with no resolved time records nothing useful');
    } finally {
      removeStub();
      if (previousProvider === undefined) delete process.env.MAYBESITTER_LLM_PROVIDER;
      else process.env.MAYBESITTER_LLM_PROVIDER = previousProvider;
      if (previousLocation === undefined) delete process.env.MAYBESITTER_VERTEX_LOCATION;
      else process.env.MAYBESITTER_VERTEX_LOCATION = previousLocation;
      resetProviderForTests();
    }
  } finally {
    teardown();
  }
});
