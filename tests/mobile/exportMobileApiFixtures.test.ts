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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { createStorageFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';
import {
  DELETE as commitmentDelete,
  GET as commitmentGet,
  PATCH as commitmentPatch,
} from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';
import { commitmentValidator } from '../../lib/services/mobile/commitmentValidator.ts';
import { GET as nextStepGet } from '../../src/app/api/mobile/recommendations/next-step/route.ts';
import { POST as nextStepActionPost } from '../../src/app/api/mobile/recommendations/next-step/actions/route.ts';
import { GET as trustGet, POST as trustPost } from '../../src/app/api/mobile/pilot/trust/route.ts';
import { GET as feedbackHistoryGet } from '../../src/app/api/mobile/feedback/history/route.ts';
import { POST as feedbackRevokePost } from '../../src/app/api/mobile/feedback/[id]/revoke/route.ts';
import { POST as alphaFeedbackPost } from '../../src/app/api/mobile/alpha/feedback/route.ts';
import { POST as analyticsPost } from '../../src/app/api/mobile/analytics/route.ts';

const BASE = 'http://127.0.0.1:4321';
const REFERENCE_TIME = '2026-08-09T08:00:00.000Z';
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
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const STABLE_INSTANT = '2026-08-09T09:00:00.000Z';

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
  };
  process.env.MAYBESITTER_DATA_DIR = directory;
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS = 'true';
  process.env.MAYBESITTER_ALPHA_FEEDBACK_ENABLED = 'true';
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
        body: JSON.stringify({ title: 'Call the dentist', dueDate: '2026-08-10T14:00:00.000Z' }),
      }),
      params(commitmentId),
    ));

    await record('commitments.action', 200, await actionPost(
      request(`/api/mobile/commitments/${commitmentId}/actions`, { body: { action: 'complete' } }),
      params(commitmentId),
    ));

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
    await applyTrustAction(USER, { type: 'grant_recommendation_consent', at: new Date().toISOString() });

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

    // ── the refusals every screen must be able to render ───────────
    const unauthenticated = await commitmentGet(
      new Request(`${BASE}/api/mobile/commitments/${commitmentId}`, { headers: new Headers() }),
      params(commitmentId),
    );
    await record('errors.unauthorized', 401, unauthenticated);
  } finally {
    teardown();
  }
});
