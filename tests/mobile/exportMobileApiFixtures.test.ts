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
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { setRecommendationConsent } from '../../lib/consents/recommendationConsentService.ts';
import { createStorageFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { COMMITMENTS, EVENTS, userDoc, userSubDoc, WATCHER_EVENTS, WATCHERS } from '../../lib/storage/paths.ts';
import { setPersonalizationConsent } from '../../lib/consents/personalizationConsentService.ts';
import { POST as memorySuggestionPost } from '../../src/app/api/mobile/memory/suggestions/[ruleId]/route.ts';
import { GET as financialContextGet } from '../../src/app/api/mobile/financial/context/route.ts';
import {
  GET as financialManualGet,
  PUT as financialManualPut,
} from '../../src/app/api/mobile/financial/manual/route.ts';
import {
  GET as financialConnectionGet,
  POST as financialConnectionPost,
} from '../../src/app/api/mobile/financial/connection/route.ts';
import { PUT as personalizationConsentPut } from '../../src/app/api/mobile/consents/personalization/route.ts';
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
import { GET as backgroundActivityHistoryGet } from '../../src/app/api/mobile/trust/background-activity/history/route.ts';
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
import { POST as importPost } from '../../src/app/api/mobile/profile/import/route.ts';
import { POST as importConfirmPost } from '../../src/app/api/mobile/profile/import/confirm/route.ts';
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
  PERSONALIZATION_CONSENT_VERSION,
  RECOMMENDATION_CONSENT_VERSION,
} from '../../src/contracts/v1/consentContracts.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { GET as planCauseGet } from '../../src/app/api/mobile/plans/[date]/cause/route.ts';
import { POST as planActionPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';
import { POST as planRegeneratePost } from '../../src/app/api/mobile/plans/[date]/regenerate/route.ts';
import { POST as planBuildPost } from '../../src/app/api/mobile/plans/[date]/build/route.ts';
import { POST as planOpenedPost } from '../../src/app/api/mobile/plans/[date]/opened/route.ts';
import type { WatcherFireEvent } from '../../src/contracts/v1/watcherContracts.ts';
import { GET as goalExecutionGet } from '../../src/app/api/mobile/goals/[goalId]/execution/route.ts';
import { POST as goalGeneratePost } from '../../src/app/api/mobile/goals/[goalId]/execution/generate/route.ts';
import { POST as goalConfirmPost } from '../../src/app/api/mobile/goals/[goalId]/execution/confirm/route.ts';
import { POST as goalRegeneratePost } from '../../src/app/api/mobile/goals/[goalId]/execution/regenerate/route.ts';
import { PATCH as goalNodePatch } from '../../src/app/api/mobile/goals/[goalId]/execution/nodes/[nodeId]/route.ts';
import { RECORDED_GOAL_STEPS_V2, seedGoal, SPLITTABLE_GOAL, UAT_GOAL } from '../goalGraph/goalGraphSupport.ts';
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
import {
  handleCreateFeed,
  handleDeadlineDecision,
  handleDeleteFeed,
  handleListFeeds,
  handleRefreshFeed,
  handleUpdateFeed,
} from '../../lib/calendar/icsFeedRoutes.ts';
import { createInMemoryKms } from '../../lib/security/inMemoryKms.ts';
import {
  GET as reminderSettingsGet,
  PUT as reminderSettingsPut,
} from '../../src/app/api/mobile/settings/reminders/route.ts';
import { POST as hardReceiptsPost } from '../../src/app/api/mobile/reminders/receipts/route.ts';
import { POST as devicesPost } from '../../src/app/api/mobile/devices/route.ts';
import { DELETE as deviceDelete } from '../../src/app/api/mobile/devices/[installationId]/route.ts';
import { GET as accountExportGet } from '../../src/app/api/mobile/account/export/route.ts';
import {
  GET as readinessHealthGet,
  POST as readinessHealthPost,
} from '../../src/app/api/mobile/readiness/route.ts';
import { buildHealthKitReadinessSnapshot } from '../../lib/integrations/readiness/healthkit.ts';
import { resetProviderForTests } from '../../src/extraction/llm/index.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { appendPlanEvent, planPath, readStoredPlan, storePlanProposal } from '../../lib/services/dailyPlan/planStore.ts';
import { diffPlans } from '../../lib/planning/scheduler/index.ts';
import { GET as readinessGet, PUT as readinessPut } from '../../src/app/api/mobile/readiness/route.ts';
import { GET as watchersGet, POST as watchersPost } from '../../src/app/api/mobile/watchers/route.ts';
import { POST as watcherPausePost } from '../../src/app/api/mobile/watchers/[id]/pause/route.ts';

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
const GOAL_USER = uidFor('GoalFixtureUser');

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
/**
 * `wtc_<uuid>` — a watcher id (#525). Keeps its prefix and its shape; an id
 * this file already wrote as a stable literal is left exactly as it is.
 */
const WATCHER_ID = /^wtc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STABLE_WATCHER_ID = /^wtc_00000000-0000-4000-8000-\d{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const STABLE_INSTANT = '2026-08-09T09:00:00.000Z';
/**
 * A daily-action counter in the export (`users/{uid}/usage/<action>-<yyyy-mm-dd>`,
 * written by the export route's own rate limit, `reserveDailyAction`). Its id
 * and its `date` field carry the real day the test ran, so they are pinned to
 * the reference day — and only they: see `stabiliseDailyCounters`.
 */
const DAILY_COUNTER_ID = /^([a-z][a-z0-9_]*)-(\d{4}-\d{2}-\d{2})$/;
const STABLE_DAY = '2026-08-09';

/**
 * Pins the day in the export's daily usage counters, by shape and by place.
 *
 * Only documents in `collections.usage` whose id is `<action>-<yyyy-mm-dd>`
 * are touched: the id's day, and a `date` field equal to that same day. Every
 * other string in the export — including one that happens to be today's date —
 * is recorded as the route returned it. Keyed on the id's own day rather than
 * on "today", so a run that crosses midnight records the same file.
 */
function stabiliseDailyCounters(body: Record<string, unknown>): Record<string, unknown> {
  const collections = body.collections as Record<string, unknown> | undefined;
  const usage = collections?.usage;
  if (!Array.isArray(usage)) return body;
  const pinned = usage.map((doc: { id?: unknown; data?: Record<string, unknown> }) => {
    const match = typeof doc?.id === 'string' ? DAILY_COUNTER_ID.exec(doc.id) : null;
    if (!match) return doc;
    const day = match[2]!;
    const data = doc.data && doc.data.date === day ? { ...doc.data, date: STABLE_DAY } : doc.data;
    return { ...doc, id: `${match[1]}-${STABLE_DAY}`, data };
  });
  return { ...body, collections: { ...collections, usage: pinned } };
}
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
  // An activity cursor names a record, `<instant>|<id>` (#201). Opaque to the
  // client, but it carries a real clock and a fresh id.
  const cursor = /^([^|]+)\|([^|]+)$/.exec(value);
  if (cursor && INSTANT.test(cursor[1]!) && UUID.test(cursor[2]!)) {
    return `${STABLE_INSTANT}|${stableId('00000000-0000-4000-8000-', 12, counters)}`;
  }
  if (DIGEST.test(value)) return STABLE_DIGEST;
  if (MEMORY_ID.test(value)) return `mem_${stableId('00000000-0000-4000-8000-', 12, counters)}`;
  if (WATCHER_ID.test(value) && !STABLE_WATCHER_ID.test(value)) return `wtc_${stableId('00000000-0000-4000-8000-', 12, counters)}`;
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

/**
 * Ten things finished in Jerusalem, seven of them between 09:00 and 12:00,
 * spread over the last ten days of the real clock (the memory route reads it),
 * with personalization consent on. Each instant is found by asking `Intl` what
 * the wall clock read rather than by assuming an offset.
 */
async function seedFocusHabit(uid: string): Promise<void> {
  const nowMs = Date.now();
  const at = (daysAgo: number, hour: number, minute: number): string => {
    const base = new Date(nowMs - daysAgo * 86_400_000);
    for (let utcShift = -14; utcShift <= 14; utcShift += 1) {
      const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour - utcShift, minute));
      const shown = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(candidate).find(part => part.type === 'hour')!.value;
      if (Number(shown) === hour && candidate.getTime() < nowMs) return candidate.toISOString();
    }
    throw new Error('no instant');
  };
  await getStorage().set(userDoc(uid), { uid, timezone: 'Asia/Jerusalem' });
  const times: Array<[number, number, number]> = [
    [1, 9, 15], [2, 9, 40], [3, 10, 0], [5, 10, 30], [6, 11, 0], [8, 11, 20], [9, 11, 45],
    [4, 19, 5], [7, 20, 5], [10, 21, 5],
  ];
  for (let index = 0; index < times.length; index += 1) {
    const [daysAgo, hour, minute] = times[index]!;
    const id = `ev_growth_${index}`;
    await getStorage().set(userSubDoc(uid, EVENTS, id), {
      id, type: 'commitment_completed', at: at(daysAgo, hour, minute), aggregateId: `c_growth_${index}`, payload: {},
    });
  }
  await setPersonalizationConsent(uid, {
    state: 'granted',
    version: PERSONALIZATION_CONSENT_VERSION,
    at: new Date(nowMs - 60_000),
  });
}

/**
 * Six "Later"s, four of them an hour long — the shape R2 reads (UC-3.14,
 * #532). A defer's length is the gap between two instants, so unlike the focus
 * habit above this needs no wall clock and no zone.
 */
async function seedDeferHabit(uid: string): Promise<void> {
  const nowMs = Date.now();
  await getStorage().set(userDoc(uid), { uid, timezone: 'Asia/Jerusalem' });
  const durations = [60, 60, 180, 60, 180, 60];
  for (let index = 0; index < durations.length; index += 1) {
    const at = new Date(nowMs - (index + 1) * 86_400_000);
    const id = `ev_defer_${index}`;
    await getStorage().set(userSubDoc(uid, EVENTS, id), {
      id,
      type: 'commitment_postponed',
      at: at.toISOString(),
      aggregateId: `c_defer_${index}`,
      payload: { postponedUntil: new Date(at.getTime() + durations[index]! * 60_000).toISOString() },
    });
  }
  await setPersonalizationConsent(uid, {
    state: 'granted',
    version: PERSONALIZATION_CONSENT_VERSION,
    at: new Date(nowMs - 60_000),
  });
}

/**
 * Seven plan days, five of them opened in the 08:00 half-hour and two in the
 * evening — the shape R3 reads (#533). The opens are appended to the plan
 * ledger the way the route appends them; no planSettings row, so the delivery
 * time defaults to 07:30 and the delivery exclusion has nothing to take. The
 * plan documents themselves do not exist: R3 reads the ledger, not the plans.
 */
async function seedPlanOpenHabit(uid: string): Promise<void> {
  const nowMs = Date.now();
  const at = (daysAgo: number, hour: number, minute: number): string => {
    const base = new Date(nowMs - daysAgo * 86_400_000);
    for (let utcShift = -14; utcShift <= 14; utcShift += 1) {
      const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour - utcShift, minute));
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(candidate);
      const shownHour = Number(parts.find(part => part.type === 'hour')!.value);
      if (shownHour === hour && candidate.getTime() < nowMs) return candidate.toISOString();
    }
    throw new Error('no instant');
  };
  const date = (daysAgo: number): string => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(nowMs - daysAgo * 86_400_000));
    const part = (type: string) => parts.find(entry => entry.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  await getStorage().set(userDoc(uid), { uid, timezone: 'Asia/Jerusalem' });
  const opens: Array<[number, number, number]> = [
    [1, 8, 12], [2, 8, 26], [3, 21, 5], [4, 8, 4], [5, 21, 40], [6, 8, 29], [7, 8, 0],
  ];
  for (const [daysAgo, hour, minute] of opens) {
    await appendPlanEvent(uid, {
      type: 'plan_opened',
      date: date(daysAgo),
      at: at(daysAgo, hour, minute),
      generation: 1,
      inputDigest: 'digest',
    });
  }
  await setPersonalizationConsent(uid, {
    state: 'granted',
    version: PERSONALIZATION_CONSENT_VERSION,
    at: new Date(nowMs - 60_000),
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
async function record(
  name: string,
  expectedStatus: number,
  response: Response,
  pin: (body: Record<string, unknown>) => Record<string, unknown> = (body) => body,
): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(
    response.status,
    expectedStatus,
    `${name}: expected ${expectedStatus}, got ${response.status} — ${JSON.stringify(body)}`,
  );
  const stable = stabilise(pin(body), new Map());
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

    // ── saved Goal → reviewed work (#526) ─────────────────────────
    const { goal } = await seedGoal(SPLITTABLE_GOAL, { scopeId: GOAL_USER, storage: getStorage() });
    const goalContext = { params: Promise.resolve({ goalId: goal.id }) };
    const generatedGoal = await record('goal.generated', 200, await goalGeneratePost(
      request(`/api/mobile/goals/${goal.id}/execution/generate`, { body: {}, uid: GOAL_USER }),
      goalContext,
    ));
    const goalNodeId = (generatedGoal.graph as { nodes: Array<{ kind: string; nodeId: string }> }).nodes
      .find(node => node.kind === 'decomposition_step_proposal')!.nodeId;
    const confirmedGoal = await record('goal.confirmed', 200, await goalConfirmPost(
      request(`/api/mobile/goals/${goal.id}/execution/confirm`, {
        body: { generation: 1, selections: [{ nodeId: goalNodeId, as: 'commitment' }] }, uid: GOAL_USER,
      }),
      { params: Promise.resolve({ goalId: goal.id }) },
    ));
    await record('goal.execution', 200, await goalExecutionGet(
      request(`/api/mobile/goals/${goal.id}/execution?generation=1&fromLocalDate=2026-09-20&toLocalDate=2026-09-26`, { uid: GOAL_USER }),
      { params: Promise.resolve({ goalId: goal.id }) },
    ));
    const regeneratedGoal = await record('goal.regenerated', 200, await goalRegeneratePost(
      request(`/api/mobile/goals/${goal.id}/execution/regenerate`, { body: { fromGeneration: 1 }, uid: GOAL_USER }),
      { params: Promise.resolve({ goalId: goal.id }) },
    ));
    const linkedNodeId = (regeneratedGoal.graph as { nodes: Array<{ kind: string; nodeId: string }> }).nodes
      .find(node => node.kind === 'linked_commitment')!.nodeId;
    assert.equal((confirmedGoal.created as unknown[]).length, 1);
    await record('goal.unlinked', 200, await goalNodePatch(
      request(`/api/mobile/goals/${goal.id}/execution/nodes/${linkedNodeId}`, { method: 'PATCH', body: { action: 'unlink' }, uid: GOAL_USER }),
      { params: Promise.resolve({ goalId: goal.id, nodeId: linkedNodeId }) },
    ));

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

    // ── the owner's first-run sentence (L4) ────────────────────────
    // «سجّل موعد دكتور يوم الأحد», literally, through the real route. The
    // reference time is a Sunday, so this is also the "not today" rule: the
    // answer is next Sunday, one item, `needs_clarification`, a Must we
    // guessed, a day we guessed, and an hour question that names that day.
    // Day keys are not normalised — only instants are — so `resolvedDate`
    // below is the real one, beside a `resolvedTime` the exporter rewrote.
    const doctor = await record('capture.guessedWeekday', 200, await capturePost(request('/api/mobile/capture', {
      body: { text: 'سجّل موعد دكتور يوم الأحد', referenceTime: REFERENCE_TIME, timezone: 'Asia/Jerusalem' },
    })));
    assert.equal(doctor.status, 'needs_clarification');
    const doctorItems = doctor.items as Array<{
      itemId: string; title: string; resolvedTime: string | null; resolvedDate?: string; dateEstimated?: boolean; priority?: string;
      clarification: { questionId: string; questionKey: string; params: Record<string, string>; options: Array<{ optionId: string }> } | null;
    }>;
    assert.equal(doctorItems.length, 1);
    const doctorItem = doctorItems[0]!;
    // «سجّل» was an instruction to the app, not part of the task (round 2).
    assert.equal(doctorItem.title, 'موعد دكتور');
    assert.equal(doctorItem.resolvedTime, null);
    assert.equal(doctorItem.resolvedDate, '2026-08-16');
    assert.equal(doctorItem.dateEstimated, true);
    assert.equal(doctorItem.priority, 'high');
    assert.equal(doctorItem.clarification?.questionKey, 'ask_time');
    assert.equal(doctorItem.clarification?.params.date, '2026-08-16');
    const morning = doctorItem.clarification!.options.find((option) => option.optionId === 'morning');
    assert.ok(morning, 'the hour question offers a morning on that Sunday');
    await record('capture.guessedWeekdayClarified', 200, await clarifyPost(request('/api/mobile/capture/clarify', {
      body: {
        proposalId: doctor.proposalId,
        itemId: doctorItem.itemId,
        questionId: doctorItem.clarification!.questionId,
        optionId: morning.optionId,
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
    // ── subscribed calendar feeds (UC-3.4, #188) ───────────────────
    // Recorded through the handlers every `/calendar/ics` route file calls
    // once it has authenticated (lib/calendar/icsFeedRoutes). Two things are
    // injected, and only two: the network — a fetch that answers a small
    // Moodle-shaped calendar instead of dialling out — and the in-memory KMS
    // double, because the real key does not exist here. Everything else,
    // including the feature flag's own check, is the production path.
    // Its own account, so accepting a deadline here does not add a commitment
    // to the activity and trust fixtures recorded for FixtureUser.
    {
      const ICS_USER = uidFor('IcsFixtureUser');
      const icsConsentAt = new Date().toISOString();
      await applyTrustAction(ICS_USER, { type: 'record_first_value', at: icsConsentAt });
      await applyTrustAction(ICS_USER, { type: 'set_calendar_consent', granted: true, at: icsConsentAt });
      const icsKms = createInMemoryKms();
      const icsNow = new Date();
      const stamp = (hours: number) => new Date(icsNow.getTime() + hours * 3_600_000)
        .toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const calendarBody = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Moodle Pty Ltd//NONSGML Moodle//EN',
        'BEGIN:VEVENT', 'UID:essay@moodle.example', 'SUMMARY:Essay 1 is due', 'DTSTAMP:20260915T080000Z',
        `DTSTART:${stamp(48)}`, `DTEND:${stamp(48)}`, 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:lecture@moodle.example', 'SUMMARY:CS101 Lecture', 'DTSTAMP:20260915T080000Z',
        `DTSTART:${stamp(5)}`, `DTEND:${stamp(7)}`, 'END:VEVENT',
        'END:VCALENDAR', '',
      ].join('\r\n');
      const icsDeps = {
        env: { NODE_ENV: 'test', ICS_FEEDS_ENABLED: 'true' } as NodeJS.ProcessEnv,
        encryption: { kms: icsKms, env: { NODE_ENV: 'test', MAYBESITTER_KMS_KEY_NAME: icsKms.keyName } as NodeJS.ProcessEnv },
        log: () => undefined,
        fetch: async () => ({ notModified: false as const, body: calendarBody, etag: null, lastModified: null }),
      };
      const feedUrl = 'https://moodle.example/calendar/export_execute.php?authtoken=FIXTURE';

      const created = await record('icsFeeds.created', 201, await handleCreateFeed(
        request('/api/mobile/calendar/ics', { body: { url: feedUrl, label: 'CS101', autoAcceptDeadlines: false }, uid: ICS_USER }),
        ICS_USER, icsDeps,
      ));
      const feedId = (created.feed as { feedId: string }).feedId;
      assert.ok(!JSON.stringify(created).includes('authtoken'), 'a feed response carried its URL');

      const listed = await record('icsFeeds.list', 200, await handleListFeeds(request('/api/mobile/calendar/ics', { uid: ICS_USER }), ICS_USER, icsDeps));
      const itemKey = (listed.deadlines as Array<{ itemKey: string }>)[0]!.itemKey;
      assert.equal((listed.deadlines as unknown[]).length, 1);

      await record('icsFeeds.updated', 200, await handleUpdateFeed(
        request(`/api/mobile/calendar/ics/${feedId}`, { method: 'PATCH', body: { label: 'CS101 Moodle' }, uid: ICS_USER }),
        ICS_USER, feedId, icsDeps,
      ));
      await record('icsFeeds.refreshed', 200, await handleRefreshFeed(
        request(`/api/mobile/calendar/ics/${feedId}/refresh`, { method: 'POST', uid: ICS_USER }),
        ICS_USER, feedId, icsDeps,
      ));
      await record('icsFeeds.refreshTooSoon', 429, await handleRefreshFeed(
        request(`/api/mobile/calendar/ics/${feedId}/refresh`, { method: 'POST', uid: ICS_USER }),
        ICS_USER, feedId, icsDeps,
      ));
      await record('icsFeeds.deadlineAccepted', 200, await handleDeadlineDecision(
        request(`/api/mobile/calendar/ics/${feedId}/deadlines/${itemKey}`, { body: { action: 'accept' }, uid: ICS_USER }),
        ICS_USER, feedId, itemKey, icsDeps,
      ));
      await record('icsFeeds.invalidUrl', 400, await handleCreateFeed(
        request('/api/mobile/calendar/ics', { body: { url: 'http://moodle.example/calendar.ics' }, uid: ICS_USER }),
        ICS_USER, icsDeps,
      ));
      await record('icsFeeds.deleted', 200, await handleDeleteFeed(
        request(`/api/mobile/calendar/ics/${feedId}`, { method: 'DELETE', uid: ICS_USER }),
        ICS_USER, feedId, icsDeps,
      ));
    }

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


    // ── financial context (#financial-v1) ──────────────────────────
    //
    // Recorded connected and populated rather than empty. An empty state is
    // all nulls, which every schema accepts and nothing proves — the fixture
    // has to carry an amount, a provenance and a conflict, or the app's schema
    // is only ever validated against the shape of "nothing here yet".
    const financialDisconnected = await record(
      'financial.connectionOff', 200, await financialConnectionGet(request('/api/mobile/financial/connection')),
    );
    assert.equal(financialDisconnected.connected, false);

    await record('financial.connected', 201, await financialConnectionPost(
      request('/api/mobile/financial/connection', { method: 'POST' }),
    ));

    await record('financial.manualSaved', 200, await financialManualPut(
      request('/api/mobile/financial/manual', {
        method: 'PUT',
        body: { field: 'cash_available', kind: 'correction', value: 60_000 },
      }),
    ));
    await financialManualPut(request('/api/mobile/financial/manual', {
      method: 'PUT',
      body: {
        label: 'Semester B tuition', category: 'tuition',
        dueAt: '2026-08-20T00:00:00.000Z', amountMinorUnits: 200_000, currency: 'ILS',
      },
    }));

    const financialManual = await record(
      'financial.manual', 200, await financialManualGet(request('/api/mobile/financial/manual')),
    );
    assert.equal((financialManual.manual as { fields: unknown[] }).fields.length, 1);

    const financialContext = await record(
      'financial.context', 200, await financialContextGet(request(`/api/mobile/financial/context?referenceTime=${REFERENCE_TIME}`)),
    );
    const financialState = financialContext.state as {
      cashAvailable: unknown; conflicts: unknown[]; upcomingObligations: unknown[];
    };
    assert.ok(financialState.cashAvailable, 'the fixture recorded a state with no amount in it');
    assert.equal(financialState.conflicts.length, 1, 'the fixture recorded no conflict, so the app never renders one');
    assert.ok(financialState.upcomingObligations.length > 0);

    // ── trust ──────────────────────────────────────────────────────
    const trust = await record('trust.state', 200, await trustGet(request('/api/mobile/pilot/trust')));
    assert.equal(trust.success, true);

    await record('trust.updated', 200, await trustPost(request('/api/mobile/pilot/trust', {
      body: { action: { type: 'set_analytics_consent', granted: true } },
    })));

    const causeWatcherId = 'wtc_00000000-0000-4000-8000-000000000001';
    const causeEventId = 'evt_0000000000000001';
    const causeChangeId = 'watcher:0000000000000000000000000000000000000000000000000000000000000001';

    await getStorage().set(userSubDoc(USER, WATCHERS, causeWatcherId), {
      definition: {
        version: 'v1',
        schemaVersion: 'watcher-v1',
        watcherId: causeWatcherId,
        scopeId: USER,
        enabled: true,
        label: 'Low recovery monitor',
        source: { provider: 'whoop', connectionId: null, signalKind: 'readiness', subjectRef: 'self' },
        condition: { kind: 'threshold', metric: 'recovery', operator: 'lt', value: 33 },
        effect: 'replan_if_impacted',
        createdBy: 'user',
        createdAt: REFERENCE_TIME,
        updatedAt: REFERENCE_TIME,
      },
      runtime: {
        watcherId: causeWatcherId,
        scopeId: USER,
        status: 'active',
        blockedReason: null,
        lastSignalId: 'sig_0000000000000001',
        lastDigest: null,
        lastMeasures: [{ metric: 'recovery', value: 25 }],
        lastObservedAt: REFERENCE_TIME,
        lastFiredAt: REFERENCE_TIME,
        fireCount: 1,
        updatedAt: REFERENCE_TIME,
      },
    });

    const fireEvent: WatcherFireEvent = {
      version: 'v1',
      schemaVersion: 'watcher-event-v1',
      eventId: causeEventId,
      watcherId: causeWatcherId,
      scopeId: USER,
      signalId: 'sig_0000000000000001',
      provider: 'whoop',
      signalKind: 'readiness',
      subjectRef: 'self',
      observedAt: REFERENCE_TIME,
      firedAt: REFERENCE_TIME,
      effect: 'replan_if_impacted',
      outcome: 'effected',
      reason: 'threshold_crossed',
      policyDecision: 'allowed',
      provenanceRef: 'signals/sig_0000000000000001',
      effectRef: causeChangeId,
    };
    await getStorage().set(userSubDoc(USER, WATCHER_EVENTS, causeEventId), fireEvent);

    const backgroundHistory = await record(
      'backgroundActivity.history',
      200,
      await backgroundActivityHistoryGet(request('/api/mobile/trust/background-activity/history')),
    );
    assert.ok(
      ((backgroundHistory.items as unknown[]).length) >= 1,
      'the background activity history fixture recorded no item',
    );

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

    // ── the AI context import pair ────────────────────────────────
    // No model here either, so the candidate list comes back empty — again the
    // shape the review screen has to handle, and the honest record of this
    // handler without one. What matters in the fixture is the fields around it:
    // the summary the screen reads before the user commits, and how many
    // existing records the comparison actually covered.
    const imported = await record('profile.imported', 200, await importPost(request('/api/mobile/profile/import', {
      body: { text: 'They are a nursing student who wants to run a 10k.', assistant: 'chatgpt' },
    })));

    await record('profile.importConfirmed', 200, await importConfirmPost(
      request('/api/mobile/profile/import/confirm', {
        body: { proposalId: (imported as { proposalId: string }).proposalId, accepted: [] },
      }),
    ));

    // The refusals the screen tells apart: a paste past the cap, which carries
    // the number it may show, and a proposal that expired while it was read.
    await record('profile.importTooLong', 413, await importPost(request('/api/mobile/profile/import', {
      body: { text: 'x'.repeat(4_001), assistant: 'chatgpt' },
    })));

    await record('profile.importExpired', 404, await importConfirmPost(
      request('/api/mobile/profile/import/confirm', {
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

    await record('consents.personalizationRecorded', 200, await personalizationConsentPut(
      request('/api/mobile/consents/personalization', {
        method: 'PUT',
        body: { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, locale: 'ar', platform: 'ios' },
      }),
    ));
    // Answered and withdrawn again, so the fixture set does not leave this
    // account personalizing while the rest of the run records other routes.
    await personalizationConsentPut(request('/api/mobile/consents/personalization', {
      method: 'PUT',
      body: { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION },
    }));

    // ── memory growth (#202) ───────────────────────────────────────
    // Accounts of their own, so the capture flows above — whose completions
    // land at whatever hour this suite happens to run — cannot move the window
    // or the counts in these fixtures.
    const growthKeeper = uidFor('FixtureGrowthKeep');
    const growthDismisser = uidFor('FixtureGrowthDismiss');
    for (const uid of [growthKeeper, growthDismisser]) await seedFocusHabit(uid);

    const withSuggestion = await record('memory.withSuggestion', 200, await memoryGet(
      request('/api/mobile/memory', { uid: growthKeeper }),
    ));
    const fingerprint = (withSuggestion.suggestions as Array<{ fingerprint: string }>)[0]!.fingerprint;
    const suggestionRequest = (uid: string, body: unknown) => memorySuggestionPost(
      request('/api/mobile/memory/suggestions/R1_focus_window', { uid, body }),
      { params: Promise.resolve({ ruleId: 'R1_focus_window' }) },
    );
    await record('memory.suggestionKept', 201, await suggestionRequest(
      growthKeeper, { decision: 'keep', fingerprint, language: 'en' },
    ));
    await record('memory.suggestionStale', 409, await suggestionRequest(
      growthKeeper, { decision: 'keep', fingerprint, language: 'en' },
    ));
    await record('memory.suggestionDismissed', 200, await suggestionRequest(
      growthDismisser, { decision: 'dismiss', fingerprint },
    ));

    // R2 (#532), on an account that has only ever pushed things later, so the
    // recorded response carries the defer suggestion and nothing else.
    const growthDeferrer = uidFor('FixtureGrowthDefer');
    await seedDeferHabit(growthDeferrer);
    const withDeferSuggestion = await record('memory.withDeferSuggestion', 200, await memoryGet(
      request('/api/mobile/memory', { uid: growthDeferrer }),
    ));
    const deferFingerprint = (withDeferSuggestion.suggestions as Array<{ fingerprint: string }>)[0]!.fingerprint;
    await record('memory.deferSuggestionKept', 201, await memorySuggestionPost(
      request('/api/mobile/memory/suggestions/R2_defer_default', {
        uid: growthDeferrer,
        body: { decision: 'keep', fingerprint: deferFingerprint, language: 'en' },
      }),
      { params: Promise.resolve({ ruleId: 'R2_defer_default' }) },
    ));

    // R3 (#533), on an account that has only ever opened its plan, so the
    // recorded response carries the plan-time suggestion and nothing else.
    const growthPlanOpener = uidFor('FixtureGrowthPlanOpen');
    await seedPlanOpenHabit(growthPlanOpener);
    const withPlanTimeSuggestion = await record('memory.withPlanTimeSuggestion', 200, await memoryGet(
      request('/api/mobile/memory', { uid: growthPlanOpener }),
    ));
    assert.deepEqual(
      (withPlanTimeSuggestion.suggestions as Array<{ ruleId: string }>).map((suggestion) => suggestion.ruleId),
      ['R3_plan_time'],
      'the plan-open fixture carries a suggestion that is not R3, so the client schema it exists to pin is never exercised',
    );
    const planTimeFingerprintValue = (withPlanTimeSuggestion.suggestions as Array<{ fingerprint: string }>)[0]!.fingerprint;
    await record('memory.planTimeSuggestionKept', 201, await memorySuggestionPost(
      request('/api/mobile/memory/suggestions/R3_plan_time', {
        uid: growthPlanOpener,
        body: { decision: 'keep', fingerprint: planTimeFingerprintValue, language: 'en' },
      }),
      { params: Promise.resolve({ ruleId: 'R3_plan_time' }) },
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

    // "The plan was put on screen" (#533): the acknowledgement carries nothing
    // back — the append to the plan ledger is the point of the call.
    await record('plan.opened', 200, await planOpenedPost(
      request(`/api/mobile/plans/${PLAN_DATE}/opened`),
      dateParams(PLAN_DATE),
    ));

    // The acceptance, read back through the history (#201). It lives in the
    // plan ledger, not the domain log, so this is the fixture that proves the
    // activity route reads both. A page of one: the acceptance is the newest
    // thing this account did, and a full page also pins the non-null cursor
    // the client echoes back.
    const withPlan = await record('activity.planAccepted', 200, await activityGet(
      request('/api/mobile/activity?limit=1'),
    ));
    assert.deepEqual(
      (withPlan.items as Array<{ kind: string; detail?: unknown }>).map((item) => [item.kind, item.detail]),
      [['plan_accepted', { planDate: PLAN_DATE }]],
    );
    assert.equal(typeof withPlan.nextCursor, 'string');

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

    /*
     * A plan carrying an actual protection (#522).
     *
     * Recorded last on this date, so nothing above it shifts. Without it every
     * plan fixture answers `protections: []` and the client's
     * `blockProtectionSchema` — five fields, two of them nullable — is never
     * once parsed against something a real handler produced. That is the
     * defect #493 shipped: a schema checked only against the empty case is a
     * schema nobody has checked.
     *
     * The block id comes off the scheduled row rather than being derived here,
     * which is also the assertion that the row carries one at all: a client
     * with no `blockId` cannot make this call, and deriving the id in this
     * test would hide exactly that.
     */
    const protectable = (plan.plan as { scheduled: Array<{ blockId: string | null }> }).scheduled[0];
    assert.ok(
      protectable?.blockId,
      'a scheduled row carries no blockId, so the protect action is unreachable from the client',
    );
    const protectedPlan = await record('plan.protected', 200, await planActionPost(
      request(`/api/mobile/plans/${PLAN_DATE}/actions`, {
        body: {
          action: 'protect',
          blockId: protectable.blockId,
          ownership: 'protected_flexible',
          maxShiftMinutes: 30,
        },
      }),
      dateParams(PLAN_DATE),
    ));
    assert.equal(
      ((protectedPlan.plan as { protections: unknown[] }).protections).length,
      1,
      'the protected fixture carries no protection, so the schema it exists to pin is never exercised',
    );

    /*
     * A plan with a live continuous-replan proposal beside it (#523).
     *
     * Every other plan fixture answers `proposal: null`, so until this one the
     * client's `pendingPlanProposalSchema` — and `protections[].overridden`,
     * the field the review screen must disclose — had never been parsed
     * against anything a real handler produced. The patch is stored the way
     * the replan service stores one (`storePlanProposal`, a CAS on the base
     * generation) and read back through the real GET.
     *
     * It is built to exercise the two shapes the screen has to get right: the
     * whole day an hour later, which pushes the block protected above past its
     * 30-minute allowance (`overridden: true`), and the last item dropped into
     * `unscheduled` (a `removed` change). The reason is the one
     * `evaluateReplanPolicy` gives any diff with a removal (its rule 3 runs
     * before the churn rule), so the fixture is a state the server can
     * actually produce — and it is an internal code the screen must never show
     * raw.
     */
    const base = await readStoredPlan(USER, PLAN_DATE);
    assert.ok(base, 'the protected plan must still be stored');
    const hourLater = (interval: { startsAt: string; endsAt: string }) => ({
      startsAt: new Date(Date.parse(interval.startsAt) + 60 * 60_000).toISOString(),
      endsAt: new Date(Date.parse(interval.endsAt) + 60 * 60_000).toISOString(),
    });
    const dropped = base.plan.scheduled[base.plan.scheduled.length - 1]!;
    // The protected block is the first scheduled row, the dropped one the last.
    assert.ok(base.plan.scheduled.length >= 2, 'the proposal fixture needs a protected row and a different one to drop');
    const patched = {
      ...base.plan,
      scheduled: base.plan.scheduled
        .filter((item) => item.itemId !== dropped.itemId)
        .map((item) => ({ ...item, interval: hourLater(item.interval), reservedInterval: hourLater(item.reservedInterval) })),
      unscheduled: [
        ...base.plan.unscheduled,
        { itemId: dropped.itemId, reason: { code: 'NO_FEASIBLE_SLOT' as const, itemId: dropped.itemId, detail: 'fixture' } },
      ],
    };
    const offered = await storePlanProposal(USER, PLAN_DATE, {
      proposalId: 'prp_fixture',
      proposedAt: REFERENCE_TIME,
      baseGeneration: base.generation,
      baseInputDigest: base.inputDigest,
      plan: patched,
      solveInputs: { constraints: base.constraints, config: base.config },
      diff: diffPlans(base.plan, patched),
      reason: 'contains_removals',
      userControlMode: 'automatic_time_only',
      causeChangeIds: ['chg_fixture_calendar'],
    });
    assert.ok(offered?.proposal, 'a patch of the current generation must be stored');
    // An offer expires with its plan's day (#611 guards), and the handlers
    // read the wall clock. Pinned to the reference morning, inside the plan's
    // day, for the read and for the acceptance below, as `plan.built` is.
    mock.timers.enable({ apis: ['Date'], now: Date.parse(REFERENCE_TIME) });
    const withProposal = await record('plan.withProposal', 200, await planGet(
      request(`/api/mobile/plans/${PLAN_DATE}`),
      dateParams(PLAN_DATE),
    )).finally(() => mock.timers.reset());
    const liveProposal = withProposal.proposal as { protections: Array<{ overridden: boolean }>; changes: Array<{ kind: string }> } | null;
    assert.ok(liveProposal, 'the proposal fixture carries no proposal');
    assert.ok(
      liveProposal.protections.some((protection) => protection.overridden),
      'the proposal fixture overrides no protection, so the disclosure it exists to pin is never exercised',
    );
    assert.ok(liveProposal.changes.some((change) => change.kind === 'removed'), 'the proposal fixture removes nothing');

    const stored = await readStoredPlan(USER, PLAN_DATE);
    assert.ok(stored, 'expected stored plan');
    await getStorage().set(planPath(USER, PLAN_DATE), {
      ...stored,
      causeChangeIds: [causeChangeId],
    });

    const planCause = await record('plan.cause', 200, await planCauseGet(
      request(`/api/mobile/plans/${PLAN_DATE}/cause`),
      dateParams(PLAN_DATE),
    ));
    assert.ok(
      ((planCause.cause as { attributions: unknown[] }).attributions).length >= 1,
      'the plan cause fixture recorded no attribution',
    );

    /*
     * The proposal above, accepted through the real action and read back
     * through the history (#587). The acceptance writes two ledger rows in one
     * commit — `plan_regenerated`, which the history never shows, and
     * `plan_proposal_accepted`, which it does — so a page of one pins both
     * that the new kind reaches the client and that it reaches it once, with
     * the day it was for.
     */
    // Accepted inside the plan's own day, since an offer expires with it
    // (#611 guards). A minute after the reference morning rather than on it,
    // so the entry's instant is normalised like every other one here.
    mock.timers.enable({ apis: ['Date'], now: Date.parse(REFERENCE_TIME) + 60_000 });
    const acceptedChange = await planActionPost(
      request(`/api/mobile/plans/${PLAN_DATE}/actions`, { body: { action: 'accept_proposal' } }),
      dateParams(PLAN_DATE),
    ).finally(() => mock.timers.reset());
    assert.equal(acceptedChange.status, 200, 'the fixture proposal could not be accepted');
    // That day is earlier than the real-clock actions recorded above, so the
    // acceptance is not the newest entry in the history. The page it is on is
    // reached the way the client reaches it: by echoing each cursor back.
    let acceptedPage: Response | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < 50 && acceptedPage === null; page += 1) {
      const response = await activityGet(
        request(`/api/mobile/activity?limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`),
      );
      const body = await response.clone().json() as { items: Array<{ kind: string }>; nextCursor: string | null };
      if (body.items[0]?.kind === 'plan_proposal_accepted') acceptedPage = response;
      else cursor = body.nextCursor;
      assert.ok(acceptedPage !== null || cursor !== null, 'the acceptance never appeared in the history');
    }
    assert.ok(acceptedPage, 'the acceptance never appeared in the history');
    const withChange = await record('activity.planProposalAccepted', 200, acceptedPage);
    assert.deepEqual(
      (withChange.items as Array<{ kind: string; detail?: unknown }>).map((item) => [item.kind, item.detail]),
      [['plan_proposal_accepted', { planDate: PLAN_DATE }]],
    );

    /*
     * The two refusals the review screen has to say in words (#611). The
     * client once read both through the edit-refusal schema, which requires an
     * `itemId` this body never carries, and flattened them into "check it and
     * try again". Recorded here so the client's `planProposalRejectedSchema`
     * is checked against what the handler really sends, not against a shape
     * read out of the route's source.
     *
     * `plan.proposal.none`: the offer above was just accepted, and every
     * action clears `proposal`, so nothing is pending.
     */
    const nothingPending = await record('plan.proposal.none', 422, await planActionPost(
      request(`/api/mobile/plans/${PLAN_DATE}/actions`, { body: { action: 'accept_proposal' } }),
      dateParams(PLAN_DATE),
    ));
    assert.equal(nothingPending.reason, 'no_proposal');

    /*
     * `plan.proposal.stale`: the same offer, still on the document, after the
     * acceptance above moved the generation it was solved against. That is
     * the state `pendingProposalOf` withholds and accept refuses — an offer a
     * writer outside the actions route left behind a generation that moved on.
     * Written straight to the document rather than through
     * `storePlanProposal`, whose CAS would refuse a stale base and whose
     * `plan_proposed` entry would change the history fixtures recorded after
     * this one; the document is put back exactly as it was afterwards.
     */
    const beforeStale = await readStoredPlan(USER, PLAN_DATE);
    assert.ok(beforeStale, 'the accepted plan must still be stored');
    assert.equal(beforeStale.proposal ?? null, null, 'the acceptance must have cleared the offer');
    assert.notEqual(
      offered.proposal.baseGeneration,
      beforeStale.generation,
      'the acceptance must have moved the generation, or the offer is not stale',
    );
    await getStorage().set(planPath(USER, PLAN_DATE), { ...beforeStale, proposal: offered.proposal });
    const staleOffer = await record('plan.proposal.stale', 422, await planActionPost(
      request(`/api/mobile/plans/${PLAN_DATE}/actions`, { body: { action: 'accept_proposal' } }),
      dateParams(PLAN_DATE),
    ));
    assert.equal(staleOffer.reason, 'stale_proposal');
    await getStorage().set(planPath(USER, PLAN_DATE), beforeStale);

    await record('plan.notFound', 404, await planGet(
      request('/api/mobile/plans/2026-08-10'),
      dateParams('2026-08-10'),
    ));

    // #477: the plan screen building a day the morning job has not reached.
    // Same envelope as GET, generation 1, recorded from the real handler on the
    // date the 404 above was recorded for. A creating build is only allowed for
    // the account's today or tomorrow, so the handler's clock is pinned to the
    // reference morning, whose tomorrow that date is.
    mock.timers.enable({ apis: ['Date'], now: Date.parse(REFERENCE_TIME) });
    try {
      await record('plan.built', 200, await planBuildPost(
        request('/api/mobile/plans/2026-08-10/build', { body: {} }),
        dateParams('2026-08-10'),
      ));

      // L5: a commitment pinned to a time on that day, captured after the
      // plan was built. The plan is untouched, so reading it refreshes it (a
      // new generation that spends no rebuild), and the pinned commitment is
      // a `fixed` row rather than missing from the day. Recorded so the
      // client's `fixed` row schema is pinned by a real, non-empty answer.
      const pinned = applyDomainCommand(await readParticipantState(USER), {
        type: 'CreateDraft',
        now: REFERENCE_TIME,
        commitment: {
          id: 'plan_fixture_pinned',
          kind: 'task',
          title: 'Dentist',
          timeSpec: { kind: 'scheduled_event', dueAt: '2026-08-10T11:00:00.000Z', remindAt: '2026-08-10T11:00:00.000Z', timezone: 'Asia/Jerusalem' },
        },
        draftStatus: 'pending_confirmation',
      }).newState;
      await persistParticipantState(USER, applyDomainCommand(pinned, {
        type: 'ConfirmCommitment', commitmentId: 'plan_fixture_pinned', now: REFERENCE_TIME, reminders: [],
      }).newState);
      const refreshed = await record('plan.refreshedWithFixed', 200, await planGet(
        request('/api/mobile/plans/2026-08-10'),
        dateParams('2026-08-10'),
      ));
      const refreshedPlan = refreshed.plan as { generation: number; fixed: Array<{ itemId: string }>; rebuildsLeft: number };
      assert.equal(refreshedPlan.generation, 2, 'the stale, untouched plan was not refreshed on read');
      assert.deepEqual(refreshedPlan.fixed.map((row) => row.itemId), ['plan_fixture_pinned']);
      assert.equal(refreshedPlan.rebuildsLeft, 4, 'the automatic refresh was charged as a rebuild');
    } finally {
      mock.timers.reset();
    }

    // ── reminders and devices (#196, #184) ─────────────────────────
    // The quiet hours on this response come from the routine profile, which is
    // the one place they are stored; the PUT writes them back through to it.
    await record('reminders.settingsDefault', 200, await reminderSettingsGet(
      request('/api/mobile/settings/reminders'),
    ));
    await record('reminders.settingsSaved', 200, await reminderSettingsPut(
      request('/api/mobile/settings/reminders', {
        method: 'PUT',
        body: {
          softEnabled: true,
          softLeadMinutes: 30,
          quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Jerusalem' },
        },
      }),
    ));

    // The Must-reminder receipts (#198). A commitment this account does not
    // have, so the recorded answer is the "nothing to stand down" shape — the
    // shape is what the app parses, and it is the same either way.
    await record('reminders.receiptsRecorded', 200, await hardReceiptsPost(request('/api/mobile/reminders/receipts', {
      body: {
        installationId: '44444444-4444-4444-8444-444444444444',
        receipts: [{ commitmentId: 'fixture-must', notificationId: 'fixture-must:strong', fireAt: '2026-08-09T09:50:00.000Z', exact: true }],
      },
    })));

    const INSTALLATION = '44444444-4444-4444-8444-444444444444';
    await record('devices.registered', 200, await devicesPost(request('/api/mobile/devices', {
      body: {
        installationId: INSTALLATION,
        fcmToken: 'fGh1JkL2mNo3PqR4sTu5Vw6Xy7Za8Bc9De0FgH1IjK2LmN3OpQ4RsT5U',
        platform: 'ios',
        appVersion: '1.0.0',
        locale: 'ar',
        timezone: 'Asia/Jerusalem',
        pushPermission: 'granted',
      },
    })));
    await record('devices.forgotten', 200, await deviceDelete(
      new Request(`${BASE}/api/mobile/devices/${INSTALLATION}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tokenFor(USER)}` },
      }),
      { params: Promise.resolve({ installationId: INSTALLATION }) },
    ));

    // ── "export my data" (#174 step 7) ─────────────────────────────
    // Its own account with one known document, so the fixture is the
    // envelope the phone parses and not a dump of everything above.
    const EXPORT_USER = uidFor('ExportFixtureUser');
    await getStorage().set(userDoc(EXPORT_USER), { uid: EXPORT_USER, timezone: 'Asia/Jerusalem' });
    await getStorage().set(userSubDoc(EXPORT_USER, COMMITMENTS, 'fixture-export-commitment'), {
      id: 'fixture-export-commitment', title: 'Call the bank', status: 'active',
    });
    const exported = await record(
      'account.export', 200,
      await accountExportGet(request('/api/mobile/account/export', { uid: EXPORT_USER })),
      stabiliseDailyCounters,
    );
    assert.equal((exported.account as { uid: string }).uid, EXPORT_USER);
    // The recorded file carries the pinned day, whatever day this ran on.
    const recordedExport = JSON.parse(readFileSync(join(FIXTURES, 'account.export.json'), 'utf8')) as {
      collections: { usage: Array<{ id: string; data: { date: string } }> };
    };
    assert.deepEqual(
      recordedExport.collections.usage.map(doc => [doc.id, doc.data.date]),
      [[`account_export-${STABLE_DAY}`, STABLE_DAY]],
    );

    // ── Health → energy: the snapshot the phone sends (HealthKit) ──
    // Built by the same `buildHealthKitReadinessSnapshot` the phone's adapter
    // runs, then POSTed exactly as `postNativeReadiness` sends it, so the saved
    // answer and the read after it are the ones the energy screen meets.
    const HEALTH_USER = uidFor('HealthFixtureUser');
    await getStorage().set(userDoc(HEALTH_USER), { uid: HEALTH_USER, timezone: 'Asia/Jerusalem' });
    const healthNow = new Date();
    const healthSnapshot = buildHealthKitReadinessSnapshot({
      scopeId: 'device',
      computedAt: healthNow.toISOString(),
      windowStart: new Date(healthNow.getTime() - 24 * 3_600_000).toISOString(),
      windowEnd: healthNow.toISOString(),
      sleep: {
        observedAt: new Date(healthNow.getTime() - 3_600_000).toISOString(),
        sleepStart: new Date(healthNow.getTime() - 9 * 3_600_000).toISOString(),
        sleepEnd: new Date(healthNow.getTime() - 3_600_000).toISOString(),
        totalSleepMinutes: 450,
      },
      heart: { observedAt: new Date(healthNow.getTime() - 3_600_000).toISOString(), restingHeartRate: 58, hrvMilliseconds: 42 },
      activity: { observedAt: healthNow.toISOString(), stepCount: 4200 },
    });
    await record('readiness.healthSaved', 200, await readinessHealthPost(request('/api/mobile/readiness', {
      body: { snapshot: healthSnapshot },
      uid: HEALTH_USER,
    })));
    const fromHealth = await record('readiness.fromHealth', 200, await readinessHealthGet(request('/api/mobile/readiness', { uid: HEALTH_USER })));
    assert.equal(fromHealth.selectedSource, 'recent_readiness');
    assert.deepEqual((fromHealth.readiness as { sourceKinds: string[] }).sourceKinds, ['healthkit']);

    // ── the refusals every screen must be able to render ───────────
    const unauthenticated = await commitmentGet(
      new Request(`${BASE}/api/mobile/commitments/${commitmentId}`, { headers: new Headers() }),
      params(commitmentId),
    );
    await record('errors.unauthorized', 401, unauthenticated);

    // ── readiness (the energy screen) ──────────────────────────────
    // Recorded from the route for both states the screen meets: an account
    // that has never checked in, and the same account right after a check-in.
    // The hand-written fixture this replaces said `version: 1` and a freshness
    // of `none` — values the server never sends — so the client schema agreed
    // with it and refused every real answer.
    const READINESS_USER = uidFor('ReadinessFixtureUser');
    await getStorage().set(userDoc(READINESS_USER), { uid: READINESS_USER, timezone: 'Asia/Jerusalem' });
    const missing = await record('readiness.missing', 200, await readinessGet(request('/api/mobile/readiness', { uid: READINESS_USER })));
    assert.equal(missing.freshness, 'missing');
    assert.equal(missing.readiness, null);
    await record('readiness.saved', 200, await readinessPut(request('/api/mobile/readiness', {
      method: 'PUT',
      body: { energy: 4, observedAt: new Date().toISOString() },
      uid: READINESS_USER,
    })));
    const current = await record('readiness.current', 200, await readinessGet(request('/api/mobile/readiness', { uid: READINESS_USER })));
    assert.equal(current.freshness, 'fresh');
    assert.equal((current.readiness as { subjective?: { energy?: number } }).subjective?.energy, 4);

    // ── watchers ("تابعلي", #525) ─────────────────────────────────
    // Created with the exact body `createReadinessWatcher` sends, so the
    // fixture is the answer the phone actually gets — `label: null` included,
    // which the client schema refused, so every create looked failed and each
    // retry made another watcher.
    const WATCHER_USER = uidFor('WatcherFixtureUser');
    const created = await record('watchers.created', 201, await watchersPost(request('/api/mobile/watchers', {
      body: {
        enabled: true,
        source: { provider: 'maybesitter', connectionId: null, signalKind: 'readiness', subjectRef: 'self' },
        condition: { kind: 'digest_changed' },
        effect: 'notify',
        createdBy: 'user',
      },
      uid: WATCHER_USER,
    })));
    const watcherId = (created.watcher as { watcherId: string; label: unknown }).watcherId;
    assert.equal((created.watcher as { label: unknown }).label, null);
    await record('watchers.paused', 200, await watcherPausePost(
      request(`/api/mobile/watchers/${watcherId}/pause`, { body: { paused: true }, uid: WATCHER_USER }),
      params(watcherId),
    ));
    await record('watchers.resumed', 200, await watcherPausePost(
      request(`/api/mobile/watchers/${watcherId}/pause`, { body: { paused: false }, uid: WATCHER_USER }),
      params(watcherId),
    ));
    await record('watchers.list', 200, await watchersGet(request('/api/mobile/watchers', { uid: WATCHER_USER })));

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
      // The goal planner asks for `{ steps: [...] }`; everything else here is
      // the capture extraction. Answered with what Gemini really returned for
      // the UAT goal (CL3), so the goal fixture is the real shape.
      const schema = (input.config as { responseSchema?: { properties?: Record<string, unknown> } }).responseSchema;
      if (schema?.properties && 'steps' in schema.properties) {
        return {
          text: RECORDED_GOAL_STEPS_V2,
          modelVersion: 'gemini-2.5-flash',
          usageMetadata: { promptTokenCount: 388, candidatesTokenCount: 132 },
        };
      }
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

      // ── a goal's steps from the planner model (CL3) ────────────────
      // The same consented account as the capture above, so the model path
      // is the one a consented user gets, and the fixture carries
      // `suggestedAs` / `suggestedWhen` for the client schema to accept.
      const { goal: uatGoal } = await seedGoal(UAT_GOAL, { scopeId: USER, language: 'ar', storage: getStorage() });
      const geminiGoal = await record('goal.geminiGenerated', 200, await goalGeneratePost(
        request(`/api/mobile/goals/${uatGoal.id}/execution/generate`, { body: {} }),
        { params: Promise.resolve({ goalId: uatGoal.id }) },
      ));
      assert.equal(vertexCalls, 2, 'the goal never reached the provider');
      const geminiGraph = geminiGoal.graph as { provenance: { stepSource: string }; nodes: Array<{ kind: string; suggestedAs?: string }> };
      assert.equal(geminiGraph.provenance.stepSource, 'model');
      assert.equal(geminiGraph.nodes.filter((node) => node.kind === 'decomposition_step_proposal').length, 5);
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

test('the export fixture pins only the daily usage counter\'s day, and pins it the same across a midnight', () => {
  const exportOn = (day: string) => ({
    exportedAt: `${day}T23:59:59.000Z`,
    collections: {
      usage: [
        { id: `account_export-${day}`, data: { calls: 1, date: day } },
        // Not a daily counter: no `<action>-<day>` id, so untouched.
        { id: 'llm-tokens', data: { calls: 3, date: day } },
      ],
      plans: [{ id: day, data: { date: day, title: `Trip ends ${day}`, ref: `plan-${day}` } }],
      stats: [{ id: 'activity', data: { lastDay: day } }],
    },
  });
  const before = stabiliseDailyCounters(exportOn('2026-09-25'));
  const after = stabiliseDailyCounters(exportOn('2026-09-26'));

  // The counter is pinned by its own day, not by "today": both sides of a
  // midnight record the same counter.
  const usageOf = (body: Record<string, unknown>) => (body.collections as { usage: unknown[] }).usage[0];
  assert.deepEqual(usageOf(before), { id: `account_export-${STABLE_DAY}`, data: { calls: 1, date: STABLE_DAY } });
  assert.deepEqual(usageOf(after), usageOf(before));

  // Everything else that happens to hold a day is recorded as the route sent it.
  const other = (body: Record<string, unknown>) => {
    const collections = body.collections as Record<string, unknown[]>;
    return { second: collections.usage[1], plans: collections.plans, stats: collections.stats, exportedAt: body.exportedAt };
  };
  const untouched = exportOn('2026-09-25');
  assert.deepEqual(other(before), {
    second: untouched.collections.usage[1],
    plans: untouched.collections.plans,
    stats: untouched.collections.stats,
    exportedAt: untouched.exportedAt,
  });
  // And the generic stabiliser no longer knows anything about days.
  assert.equal(stabilise('2026-09-25', new Map()), '2026-09-25');
  assert.equal(stabilise(`plan-${new Date().toISOString().slice(0, 10)}`, new Map()), `plan-${new Date().toISOString().slice(0, 10)}`);
});
