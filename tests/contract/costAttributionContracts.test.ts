import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COST_ATTRIBUTION_CONTRACT_VERSION,
  COST_ATTRIBUTION_PRIVACY_POLICY,
  COST_ATTRIBUTION_SCHEMA_VERSION,
  aggregateCostEvents,
  isCostFree,
  type CostAttributionEvent,
} from '../../src/contracts/v1/costAttributionContracts.ts';
import { MODULE_CONTRACT_VERSION } from '../../src/contracts/v1/moduleContracts.ts';

const PERIOD = Object.freeze({
  startsOn: '2026-09-16',
  endsOn: '2026-09-16',
  timezone: 'UTC',
});

function event(input: Partial<CostAttributionEvent> = {}): CostAttributionEvent {
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
  const llm = event({
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

test('email, Microsoft, WHOOP, and MCP calls share one attribution shape', () => {
  const providers = [
    event({ eventId: 'gmail', feature: 'email_sync', provider: 'google', providerOperation: 'gmail_history' }),
    event({ eventId: 'outlook', feature: 'email_sync', provider: 'microsoft', providerOperation: 'graph_delta' }),
    event({ eventId: 'whoop', feature: 'health_readiness', provider: 'whoop', providerOperation: 'recovery_sync' }),
    event({ eventId: 'mcp', feature: 'mcp_execution', provider: 'mcp', providerOperation: 'capability_execute' }),
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
  const free = event({
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
      event({
        eventId: 'a',
        tokenCounts: { inputTokens: 10, outputTokens: 3 },
        estimatedCostMicros: 100,
      }),
      event({
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
  const keys = Object.keys(event());
  for (const forbidden of ['rawPrompt', 'prompt', 'mailboxBody', 'transcript', 'healthSamples', 'content']) {
    assert.equal(keys.includes(forbidden), false, `${forbidden} must not be a cost-attribution field`);
  }
});
