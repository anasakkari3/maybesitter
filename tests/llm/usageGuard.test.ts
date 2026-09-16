/**
 * What a day of model calls is allowed to cost (UC-2.0, #160).
 *
 * The budget is a ₪100/month alert that stops nothing, so the cap has to. Two
 * things can empty it — one account in a loop, and everybody at once — so
 * there are two counters, and both move in the same transaction.
 *
 * The Firestore half of this is `tests/storage/llmUsageGuard.emulator.test.ts`:
 * a counter is only a cap if concurrent instances cannot both read the same
 * number, and the memory adapter cannot prove that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import {
  COST_ATTRIBUTION_CONTRACT_VERSION,
  COST_ATTRIBUTION_PRIVACY_POLICY,
  COST_ATTRIBUTION_SCHEMA_VERSION,
  aggregateCostEvents,
  isCostFree,
  type CostAttributionEvent,
} from '../../src/contracts/v1/costAttributionContracts.ts';
import {
  REVENUECAT_ENTITLEMENT_POLICY,
  decideFeatureEntitlement,
  entitlementCheckCostEvent,
  projectRevenueCatEntitlements,
} from '../../lib/integrations/revenuecat/entitlements.ts';
import { MODULE_CONTRACT_VERSION } from '../../src/contracts/v1/moduleContracts.ts';
import {
  DEFAULT_GLOBAL_DAILY_CAP,
  DEFAULT_USER_DAILY_CAP,
  callsToday,
  reserveCall,
  utcDay,
} from '../../lib/llm/usageGuard.ts';
import { buildLlmObservabilityEnvelope } from '../../lib/llm/observability.ts';

const UID = 'user_cost_guard';
const OTHER = 'user_cost_guard_other';
const PERIOD = Object.freeze({
  startsOn: '2026-09-16',
  endsOn: '2026-09-16',
  timezone: 'UTC',
});

function storage(): StorageAdapter {
  return createMemoryStorage();
}

function costEvent(input: Partial<CostAttributionEvent> = {}): CostAttributionEvent {
  return {
    version: COST_ATTRIBUTION_CONTRACT_VERSION,
    schemaVersion: COST_ATTRIBUTION_SCHEMA_VERSION,
    eventId: input.eventId ?? 'cost-1',
    scopeId: input.scopeId ?? 'user-1',
    occurredAt: input.occurredAt ?? '2026-09-16T09:00:00Z',
    period: input.period ?? PERIOD,
    feature: input.feature ?? 'capture',
    provider: input.provider ?? 'llm',
    providerOperation: input.providerOperation ?? 'structured_capture',
    status: input.status ?? 'success',
    requestCount: input.requestCount ?? 1,
    tokenCounts: input.tokenCounts,
    estimatedCostMicros: input.estimatedCostMicros ?? 1250,
    currency: input.currency ?? 'USD',
    traceId: input.traceId ?? 'trace-1',
  };
}

test('a call is reserved, and the reservation is what the counter counts', async () => {
  const store = storage();
  const now = new Date('2026-09-12T10:00:00.000Z');

  assert.equal(await reserveCall(UID, 'capture_extraction', { storage: store, now }), 'ok');
  // `tokens` is 0 until a call answers: they are committed after the fact, not
  // reserved, because the true count is only known once the provider replies.
  assert.deepEqual(await callsToday(UID, { storage: store, now }), { user: 1, global: 1, tokens: 0, minuteCalls: 1 });

  await reserveCall(UID, 'capture_extraction', { storage: store, now });
  assert.deepEqual(await callsToday(UID, { storage: store, now }), { user: 2, global: 2, tokens: 0, minuteCalls: 2 });
});

test('the call over the user daily cap is refused, and it is the 61st', async () => {
  // #160's acceptance criterion, at UC-4.5 (#181)'s launch figure of 60.
  //
  // Each call is a minute apart. It has to be: the per-minute cap #181 added is
  // eight, so sixty calls inside one minute are refused by *that* limit long
  // before the daily one — which is the whole point of having it, and is
  // asserted directly in the minute-cap test below.
  const store = storage();
  const start = new Date('2026-09-12T10:00:00.000Z');
  const userCap = DEFAULT_USER_DAILY_CAP;
  const minutesLater = (n: number) => new Date(start.getTime() + n * 60_000);

  for (let call = 0; call < userCap; call += 1) {
    const outcome = await reserveCall(UID, 'capture_extraction', { storage: store, now: minutesLater(call) });
    assert.equal(outcome, 'ok', `call ${call + 1} was refused before the cap`);
  }
  const over = minutesLater(userCap);
  assert.equal(await reserveCall(UID, 'capture_extraction', { storage: store, now: over }), 'user_cap');
  assert.equal((await callsToday(UID, { storage: store, now: over })).user, userCap, 'a refused call was still counted');
});

test('one account over its cap does not stop another account', async () => {
  const store = storage();
  const now = new Date('2026-09-12T10:00:00.000Z');
  for (let call = 0; call < 3; call += 1) {
    await reserveCall(UID, 'capture_extraction', { storage: store, now, userCap: 3 });
  }

  assert.equal(await reserveCall(UID, 'capture_extraction', { storage: store, now, userCap: 3 }), 'user_cap');
  assert.equal(await reserveCall(OTHER, 'capture_extraction', { storage: store, now, userCap: 3 }), 'ok');
});

test('the global cap refuses an account that is well under its own', async () => {
  const store = storage();
  const now = new Date('2026-09-12T10:00:00.000Z');
  for (let call = 0; call < 2; call += 1) {
    await reserveCall(OTHER, 'capture_extraction', { storage: store, now, globalCap: 2 });
  }

  const outcome = await reserveCall(UID, 'capture_extraction', { storage: store, now, globalCap: 2 });
  assert.equal(outcome, 'global_cap');
  assert.equal((await callsToday(UID, { storage: store, now })).user, 0, 'the refused account was charged for it');
});

test('the day rolls over at UTC midnight, for everyone at once', async () => {
  const store = storage();
  const lateOnTheTwelfth = new Date('2026-09-12T23:59:59.000Z');
  const earlyOnTheThirteenth = new Date('2026-09-13T00:00:01.000Z');

  await reserveCall(UID, 'capture_extraction', { storage: store, now: lateOnTheTwelfth, userCap: 1 });
  assert.equal(
    await reserveCall(UID, 'capture_extraction', { storage: store, now: lateOnTheTwelfth, userCap: 1 }),
    'user_cap',
  );

  // A minute later, a different day.
  assert.equal(
    await reserveCall(UID, 'capture_extraction', { storage: store, now: earlyOnTheThirteenth, userCap: 1 }),
    'ok',
  );
  assert.equal((await callsToday(UID, { storage: store, now: lateOnTheTwelfth })).user, 1, 'yesterday was rewritten');
  assert.equal((await callsToday(UID, { storage: store, now: earlyOnTheThirteenth })).user, 1);
});

test('the day is the UTC one, not the machine\'s', () => {
  // A per-user local day would let someone in UTC+3 reset three hours early,
  // and the global counter has no timezone to belong to at all.
  assert.equal(utcDay(new Date('2026-09-12T23:30:00.000Z')), '2026-09-12');
  assert.equal(utcDay(new Date('2026-09-13T00:30:00.000Z')), '2026-09-13');
});

test('the caps come from configuration, and a nonsense value does not disable them', async () => {
  const store = storage();
  const now = new Date('2026-09-12T10:00:00.000Z');
  const previous = process.env.MAYBESITTER_LLM_DAILY_CALL_CAP;
  try {
    process.env.MAYBESITTER_LLM_DAILY_CALL_CAP = 'lots';
    // Falls back to the default rather than to "unlimited": a typo in an
    // environment variable must not be how the cost guard is switched off.
    for (let call = 0; call < 3; call += 1) {
      assert.equal(await reserveCall(UID, 'capture_extraction', { storage: store, now }), 'ok');
    }
    assert.ok(DEFAULT_USER_DAILY_CAP > 3 && DEFAULT_GLOBAL_DAILY_CAP > 3);

    process.env.MAYBESITTER_LLM_DAILY_CALL_CAP = '0';
    assert.equal(
      await reserveCall(OTHER, 'capture_extraction', { storage: store, now }),
      'user_cap',
      'an explicit zero should stop every call',
    );
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_LLM_DAILY_CALL_CAP;
    else process.env.MAYBESITTER_LLM_DAILY_CALL_CAP = previous;
  }
});

test('cost attribution contract is versioned and privacy-safe by shape', () => {
  assert.equal(COST_ATTRIBUTION_CONTRACT_VERSION, MODULE_CONTRACT_VERSION);
  assert.equal(COST_ATTRIBUTION_SCHEMA_VERSION, 'cost-attribution-v1');
  assert.deepEqual(COST_ATTRIBUTION_PRIVACY_POLICY, {
    rawProviderContentAllowed: false,
    rawPromptAllowed: false,
    rawTranscriptAllowed: false,
    rawMailboxBodyAllowed: false,
    rawHealthSamplesAllowed: false,
    tokenTextAllowed: false,
    countsOnly: true,
  });
});

test('LLM events carry token counts and estimated cost without prompt text', () => {
  const llm = costEvent({
    feature: 'capture',
    provider: 'llm',
    providerOperation: 'gemini_capture',
    tokenCounts: { inputTokens: 1200, outputTokens: 220 },
    estimatedCostMicros: 4300,
  });

  assert.equal(llm.tokenCounts?.inputTokens, 1200);
  assert.equal(llm.estimatedCostMicros, 4300);
  assert.equal(JSON.stringify(llm).includes('prompt'), false);
});

test('LLM observability envelope reuses cost attribution and carries no raw content', () => {
  const envelope = buildLlmObservabilityEnvelope({
    eventId: 'obs-1',
    scopeId: 'scope-a',
    occurredAt: '2026-09-16T09:14:00Z',
    feature: 'observability',
    provider: 'llm',
    providerOperation: 'gemini_capture',
    status: 'success',
    inputTokens: 120.9,
    outputTokens: 33.1,
    estimatedCostMicros: 42.8,
    currency: 'USD',
    traceId: 'trace-1',
  });

  assert.equal(envelope.cost.schemaVersion, COST_ATTRIBUTION_SCHEMA_VERSION);
  assert.deepEqual(envelope.cost.period, {
    startsOn: '2026-09-16',
    endsOn: '2026-09-16',
    timezone: 'UTC',
  });
  assert.deepEqual(envelope.cost.tokenCounts, { inputTokens: 120, outputTokens: 33 });
  assert.equal(envelope.cost.estimatedCostMicros, 42);
  assert.deepEqual(envelope.privacy, {
    rawPromptIncluded: false,
    rawCompletionIncluded: false,
    providerPayloadIncluded: false,
  });
  assert.equal(JSON.stringify(envelope).includes('rawPromptText'), false);
});

test('email, Microsoft, WHOOP, and MCP calls share one attribution shape', () => {
  const providers = [
    costEvent({ eventId: 'gmail', feature: 'email_sync', provider: 'google', providerOperation: 'gmail_history' }),
    costEvent({ eventId: 'outlook', feature: 'email_sync', provider: 'microsoft', providerOperation: 'graph_delta' }),
    costEvent({ eventId: 'whoop', feature: 'health_readiness', provider: 'whoop', providerOperation: 'recovery_sync' }),
    costEvent({ eventId: 'mcp', feature: 'mcp_execution', provider: 'mcp', providerOperation: 'capability_execute' }),
  ];

  assert.deepEqual(providers.map((item) => item.provider), ['google', 'microsoft', 'whoop', 'mcp']);
  assert.deepEqual(providers.map((item) => item.version), [
    MODULE_CONTRACT_VERSION,
    MODULE_CONTRACT_VERSION,
    MODULE_CONTRACT_VERSION,
    MODULE_CONTRACT_VERSION,
  ]);
});

test('free API calls are represented as cost zero rather than a missing cost', () => {
  const free = costEvent({
    feature: 'external_task_sync',
    provider: 'todoist',
    providerOperation: 'task_read',
    estimatedCostMicros: 0,
  });

  assert.equal(isCostFree(free), true);
  assert.equal(free.estimatedCostMicros, 0);
});

test('aggregates sum requests, tokens, and costs without creating another usage store', () => {
  const aggregate = aggregateCostEvents(
    'agg-1',
    [
      costEvent({
        eventId: 'a',
        tokenCounts: { inputTokens: 10, outputTokens: 3 },
        estimatedCostMicros: 100,
      }),
      costEvent({
        eventId: 'b',
        requestCount: 2,
        tokenCounts: { inputTokens: 15, outputTokens: 5 },
        estimatedCostMicros: 200,
      }),
    ],
    '2026-09-16T10:00:00Z',
  );

  assert.equal(aggregate.requestCount, 3);
  assert.equal(aggregate.inputTokens, 25);
  assert.equal(aggregate.outputTokens, 8);
  assert.equal(aggregate.estimatedCostMicros, 300);
});

test('raw sensitive content fields are absent from the event contract', () => {
  const keys = Object.keys(costEvent());
  for (const forbidden of ['rawPrompt', 'prompt', 'mailboxBody', 'transcript', 'healthSamples', 'content']) {
    assert.equal(keys.includes(forbidden), false, `${forbidden} must not be a cost-attribution field`);
  }
});

test('RevenueCat projects verified entitlements without receipts or transaction history', () => {
  const projection = projectRevenueCatEntitlements({
    scopeId: 'scope-a',
    fetchedAt: '2026-09-16T09:00:00Z',
    now: '2026-09-16T09:01:00Z',
    entitlements: [
      {
        entitlementId: 'premium',
        isActive: true,
        expiresAt: '2026-10-16T09:00:00Z',
        willRenew: true,
        billingIssueDetectedAt: null,
        verification: 'verified',
      },
      {
        entitlementId: 'untrusted',
        isActive: true,
        expiresAt: null,
        willRenew: false,
        billingIssueDetectedAt: null,
        verification: 'unverified',
      },
    ],
  });

  assert.deepEqual(projection.entitlements.map((entry) => [entry.entitlementId, entry.status]), [
    ['premium', 'active'],
    ['untrusted', 'unverified'],
  ]);
  assert.equal(JSON.stringify(projection).includes('receipt'), false);
  assert.deepEqual(REVENUECAT_ENTITLEMENT_POLICY, {
    projectionOnly: true,
    rawReceiptAllowed: false,
    storeTransactionHistory: false,
    grantsConsent: false,
    mutatesUserState: false,
    nativeSdkRequiredAtThisBoundary: false,
  });
});

test('feature entitlement checks fail closed on stale, missing, or unverified projections', () => {
  const projection = projectRevenueCatEntitlements({
    scopeId: 'scope-a',
    fetchedAt: '2026-09-16T09:00:00Z',
    now: '2026-09-16T09:00:00Z',
    entitlements: [{
      entitlementId: 'premium',
      isActive: true,
      expiresAt: null,
      willRenew: false,
      billingIssueDetectedAt: null,
      verification: 'unverified',
    }],
  });

  assert.deepEqual(decideFeatureEntitlement({
    projection: null,
    requiredEntitlementIds: ['premium'],
    now: '2026-09-16T09:01:00Z',
    maxAgeMs: 300_000,
  }), { allowed: false, reason: 'projection_missing', entitlementId: null });
  assert.deepEqual(decideFeatureEntitlement({
    projection,
    requiredEntitlementIds: ['premium'],
    now: '2026-09-16T10:00:00Z',
    maxAgeMs: 300_000,
  }), { allowed: false, reason: 'projection_stale', entitlementId: null });
  assert.deepEqual(decideFeatureEntitlement({
    projection,
    requiredEntitlementIds: ['premium'],
    now: '2026-09-16T09:01:00Z',
    maxAgeMs: 300_000,
  }), { allowed: false, reason: 'entitlement_missing_or_inactive', entitlementId: null });
});

test('billing grace is explicit and free features do not require a provider projection', () => {
  const projection = projectRevenueCatEntitlements({
    scopeId: 'scope-a',
    fetchedAt: '2026-09-16T09:00:00Z',
    now: '2026-09-16T09:01:00Z',
    entitlements: [{
      entitlementId: 'premium',
      isActive: true,
      expiresAt: '2026-09-20T09:00:00Z',
      willRenew: true,
      billingIssueDetectedAt: '2026-09-15T09:00:00Z',
      verification: 'verified',
    }],
  });

  assert.deepEqual(decideFeatureEntitlement({
    projection,
    requiredEntitlementIds: ['premium'],
    now: '2026-09-16T09:01:00Z',
    maxAgeMs: 300_000,
  }), { allowed: true, reason: 'entitlement_grace_period', entitlementId: 'premium' });
  assert.deepEqual(decideFeatureEntitlement({
    projection: null,
    requiredEntitlementIds: [],
    now: 'not-needed-for-free-feature',
    maxAgeMs: 0,
  }), { allowed: true, reason: 'free_feature', entitlementId: null });
});

test('entitlement checks reuse provider and feature cost attribution', () => {
  const event = entitlementCheckCostEvent({
    eventId: 'entitlement-check-1',
    scopeId: 'scope-a',
    occurredAt: '2026-09-16T09:01:00Z',
    period: PERIOD,
    status: 'success',
    traceId: 'trace-entitlement',
  });

  assert.equal(event.provider, 'revenuecat');
  assert.equal(event.feature, 'subscription_entitlement');
  assert.equal(event.estimatedCostMicros, 0);
  assert.equal(isCostFree(event), true);
});
