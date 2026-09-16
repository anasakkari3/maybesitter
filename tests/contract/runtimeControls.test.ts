import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTELLIGENCE_MODULES,
  MODULE_CONTRACT_VERSION,
} from '../../src/contracts/v1/moduleContracts.ts';
import { buildWhoopReadinessSnapshot } from '../../lib/integrations/readiness/whoop.ts';
import {
  CONTEXT_PROVIDER_KINDS,
  INTEGRATION_CONNECTION_CONTRACT_VERSION,
  INTEGRATION_CONNECTION_SCHEMA_VERSION,
  isKnownContextProviderKind,
  type ContextProviderKind,
  type IntegrationConnectionRecord,
} from '../../src/contracts/v1/integrationConnectionContracts.ts';
import {
  READINESS_BOUNDARY_POLICY,
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  READINESS_SOURCE_KINDS,
  type ReadinessSnapshot,
} from '../../src/contracts/v1/readinessContracts.ts';
import {
  USER_STATE_PROJECTION_POLICY,
  USER_STATE_PROJECTION_SCHEMA_VERSION,
  type UserStateProjection,
} from '../../src/contracts/v1/userStateProjectionContracts.ts';
import {
  EXTERNAL_TASK_BOUNDARY_POLICY,
  EXTERNAL_TASK_PROVIDER_KINDS,
  EXTERNAL_TASK_SCHEMA_VERSION,
  isKnownExternalTaskProviderKind,
  type ExternalTaskReference,
} from '../../src/contracts/v1/externalTaskContracts.ts';
import {
  MODULE_FEATURE_FLAG_DEFAULTS,
  MODULE_KILL_SWITCH_DEFAULTS,
  createAuditEvent,
  readRuntimeControls,
  resolveModuleRuntime,
  type AuditSafeFields,
} from '../../src/contracts/v1/runtimeControls.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

test('runtime defaults preserve capture and keep future modules off', () => {
  assert.equal(MODULE_FEATURE_FLAG_DEFAULTS.capture, true);

  for (const module of INTELLIGENCE_MODULES) {
    assert.equal(MODULE_KILL_SWITCH_DEFAULTS[module], false);
    if (module !== 'capture') {
      assert.equal(MODULE_FEATURE_FLAG_DEFAULTS[module], false);
    }
  }
});

test('environment controls are typed per module and invalid values fail closed to defaults', () => {
  const controls = readRuntimeControls({
    MAYBESITTER_FEATURE_RECOMMENDATION: 'true',
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: 'true',
    MAYBESITTER_FEATURE_CAPTURE: 'not-a-boolean',
  });

  assert.equal(controls.version, MODULE_CONTRACT_VERSION);
  assert.equal(controls.featureFlags.recommendation, true);
  assert.equal(controls.killSwitches.recommendation, true);
  assert.equal(controls.featureFlags.capture, true);
});

test('a module kill switch selects rules-only fallback without disabling capture', () => {
  const controls = readRuntimeControls({
    MAYBESITTER_FEATURE_RECOMMENDATION: 'true',
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: 'true',
  });

  const recommendation = resolveModuleRuntime('recommendation', controls);
  const capture = resolveModuleRuntime('capture', controls);

  assert.equal(recommendation.mode, 'rules_only');
  if (recommendation.mode === 'rules_only') {
    assert.equal(recommendation.reason, 'kill_switch_active');
    assert.equal(recommendation.allowsModelExecution, false);
    assert.equal(recommendation.allowsDirectStateWrites, false);
    assert.equal(recommendation.captureRemainsAvailable, true);
  }
  assert.equal(capture.mode, 'enabled');
});

test('disabled future modules return an explicit rules-only contract', () => {
  const decision = resolveModuleRuntime('planning', readRuntimeControls({}));
  assert.equal(decision.mode, 'rules_only');
  if (decision.mode === 'rules_only') {
    assert.equal(decision.reason, 'feature_disabled');
    assert.equal(decision.captureRemainsAvailable, true);
  }
});

test('audit envelope carries correlation IDs and drops raw sensitive fields', () => {
  const unsafeFields = {
    outcome: 'fell_back',
    reasonCode: 'kill_switch_active',
    inputHash: 'sha256:example',
    inputLength: 21,
    rulesOnly: true,
    rawText: 'call my doctor tomorrow',
    prompt: 'private prompt',
  } as AuditSafeFields;

  const event = createAuditEvent({
    eventId: 'event-1',
    eventType: 'module_runtime_decision',
    occurredAt: '2026-08-03T09:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'request-1',
    module: 'recommendation',
    fields: unsafeFields,
  });

  assert.equal(event.correlationId, 'correlation-1');
  assert.equal(event.causationId, 'request-1');
  assert.equal(event.fields.inputLength, 21);
  assert.equal('rawText' in event.fields, false);
  assert.equal('prompt' in event.fields, false);
  assert.equal(JSON.stringify(event).includes('call my doctor'), false);
});

test('context provider vocabulary is provider-independent and future-safe', () => {
  assert.deepEqual(CONTEXT_PROVIDER_KINDS, [
    'google',
    'microsoft',
    'whoop',
    'rescuetime',
    'todoist',
    'notion',
    'meeting',
    'mcp',
  ]);
  assert.equal(INTEGRATION_CONNECTION_CONTRACT_VERSION, MODULE_CONTRACT_VERSION);
  assert.equal(INTEGRATION_CONNECTION_SCHEMA_VERSION, 'integration-connection-v1');
  assert.equal(isKnownContextProviderKind('google'), true);
  assert.equal(isKnownContextProviderKind('future-context-provider'), false);

  const futureProvider: ContextProviderKind = 'future-context-provider';
  const record: IntegrationConnectionRecord = {
    version: INTEGRATION_CONNECTION_CONTRACT_VERSION,
    schemaVersion: INTEGRATION_CONNECTION_SCHEMA_VERSION,
    connectionId: 'conn-1',
    scopeId: 'scope-a',
    identity: {
      provider: futureProvider,
      providerAccountId: 'acct-1',
      providerSpaceId: null,
      displayName: 'Future Provider',
    },
    state: 'connected',
    capabilities: ['calendar_busy', 'task_read'],
    grantedScopes: ['provider.scope'],
    connectedAt: '2026-09-16T08:00:00Z',
    lastSyncedAt: '2026-09-16T08:05:00Z',
    expiresAt: null,
    revokedAt: null,
    updatedAt: '2026-09-16T08:05:00Z',
  };

  assert.equal(record.identity.provider, futureProvider);
});

test('readiness snapshot supports normalized sources without diagnosis or planner-specific fields', () => {
  assert.deepEqual(READINESS_SOURCE_KINDS, [
    'healthkit',
    'health_connect',
    'whoop',
    'subjective',
  ]);
  assert.equal(READINESS_CONTRACT_VERSION, MODULE_CONTRACT_VERSION);
  assert.equal(READINESS_SCHEMA_VERSION, 'readiness-v1');
  assert.deepEqual(READINESS_BOUNDARY_POLICY, {
    medicalClaimsAllowed: false,
    providerSpecificPlannerFieldsAllowed: false,
    writesCanonicalUserState: false,
  });

  const snapshot: ReadinessSnapshot = {
    version: READINESS_CONTRACT_VERSION,
    schemaVersion: READINESS_SCHEMA_VERSION,
    scopeId: 'scope-a',
    computedAt: '2026-09-16T09:00:00Z',
    windowStart: '2026-09-15T09:00:00Z',
    windowEnd: '2026-09-16T09:00:00Z',
    band: 'steady',
    score: 0.68,
    normalizedSignals: {
      sleepDurationMinutes: 420,
      sleepStart: '2026-09-15T23:00:00Z',
      sleepEnd: '2026-09-16T06:00:00Z',
      restingHeartRate: 58,
      hrv: 42,
      recentActivityLoad: 0.4,
    },
    subjective: {
      energy: 3,
      observedAt: '2026-09-16T08:55:00Z',
    },
    derived: {
      readinessBand: 'steady',
      confidence: 0.68,
    },
    sourceKinds: ['healthkit', 'health_connect', 'whoop', 'subjective'],
    missingSourceKinds: [],
    signals: [
      {
        signalId: 'sleep-1',
        source: { kind: 'healthkit' },
        metric: 'sleep',
        observedAt: '2026-09-16T06:00:00Z',
        normalizedScore: 0.72,
        nativeValue: 420,
        nativeUnit: 'minutes',
        confidence: 0.8,
      },
      {
        signalId: 'energy-1',
        source: { kind: 'subjective' },
        metric: 'subjective_energy',
        observedAt: '2026-09-16T08:55:00Z',
        normalizedScore: 0.6,
        nativeValue: 'okay',
        nativeUnit: 'label',
        confidence: 1,
      },
    ],
  };

  assert.deepEqual(snapshot.sourceKinds, READINESS_SOURCE_KINDS);
  assert.equal(snapshot.normalizedSignals.sleepDurationMinutes, 420);
  assert.equal(snapshot.subjective?.energy, 3);
  assert.equal(snapshot.signals[0].metric, 'sleep');
  assert.equal(snapshot.signals[1].source.kind, 'subjective');
});

test('WHOOP readings normalize into the provider-independent readiness contract', () => {
  const snapshot = buildWhoopReadinessSnapshot({
    scopeId: 'scope-a',
    computedAt: '2026-09-16T09:00:00Z',
    windowStart: '2026-09-15T09:00:00Z',
    windowEnd: '2026-09-16T09:00:00Z',
    connectionId: 'conn-whoop',
    recovery: {
      observedAt: '2026-09-16T06:30:00Z',
      recoveryScore: 71,
      restingHeartRate: 57,
      hrvMilliseconds: 44,
    },
    sleep: {
      observedAt: '2026-09-16T06:20:00Z',
      sleepStart: '2026-09-15T22:45:00Z',
      sleepEnd: '2026-09-16T06:30:00Z',
      totalSleepMinutes: null,
    },
    strain: {
      observedAt: '2026-09-15T21:00:00Z',
      strainScore: 10.5,
    },
  });

  assert.equal(snapshot.schemaVersion, READINESS_SCHEMA_VERSION);
  assert.equal(snapshot.sourceKinds[0], 'whoop');
  assert.equal(snapshot.score, 0.71);
  assert.equal(snapshot.band, 'high');
  assert.equal(snapshot.normalizedSignals.sleepDurationMinutes, 465);
  assert.equal(snapshot.normalizedSignals.restingHeartRate, 57);
  assert.equal(snapshot.normalizedSignals.hrv, 44);
  assert.equal(snapshot.normalizedSignals.recentActivityLoad, 0.5);
  assert.equal(snapshot.subjective, null);
  assert.deepEqual(snapshot.missingSourceKinds, []);
  assert.ok(snapshot.signals.every((signal) => signal.source.provider === 'whoop'));
  assert.equal(snapshot.signals.some((signal) => signal.metric === 'strain'), true);
});

test('user-state projection stays projection-only and references context at a high level', () => {
  assert.equal(USER_STATE_PROJECTION_SCHEMA_VERSION, 'user-state-projection-v1');
  assert.deepEqual(USER_STATE_PROJECTION_POLICY, {
    projectionOnly: true,
    persistenceAllowed: false,
    directProviderCallsAllowed: false,
    writesCanonicalUserState: false,
  });

  const projection: UserStateProjection = {
    version: MODULE_CONTRACT_VERSION,
    schemaVersion: USER_STATE_PROJECTION_SCHEMA_VERSION,
    scopeId: 'scope-a',
    computedAt: '2026-09-16T09:00:00Z',
    readiness: null,
    current: {
      meta: {
        source: 'availability',
        freshness: 'fresh',
        updatedAt: '2026-09-16T08:45:00Z',
        inputDigest: 'sha256-availability',
      },
      busy: [{ startsAt: '2026-09-16T10:00:00Z', endsAt: '2026-09-16T10:30:00Z', timezone: 'UTC' }],
      free: [{ startsAt: '2026-09-16T11:00:00Z', endsAt: '2026-09-16T12:00:00Z', timezone: 'UTC' }],
      focus: [{ startsAt: '2026-09-16T12:30:00Z', endsAt: '2026-09-16T13:30:00Z', timezone: 'UTC' }],
    },
    relevantMemory: {
      meta: {
        source: 'memory',
        freshness: 'fresh',
        updatedAt: '2026-09-16T08:50:00Z',
        inputDigest: 'sha256-memory',
      },
      memoryIds: ['memory-1'],
      summaryDigest: 'sha256-summary',
    },
    deadlines: [
      {
        deadlineId: 'deadline-1',
        dueAt: '2026-09-16T17:00:00Z',
        kind: 'external_task',
        sourceRef: 'task-ref-1',
      },
    ],
    plan: {
      meta: {
        source: 'plan',
        freshness: 'fresh',
        updatedAt: '2026-09-16T08:55:00Z',
        inputDigest: 'sha256-plan',
      },
      status: 'proposed',
      planId: 'plan-1',
      updatedAt: '2026-09-16T08:55:00Z',
    },
    connectedContextSources: [
      {
        provider: 'mcp',
        connectionId: 'conn-mcp',
        capabilities: ['memory_context_read'],
        freshness: 'fresh',
        lastSyncedAt: '2026-09-16T08:40:00Z',
      },
    ],
  };

  assert.equal(projection.current.busy.length, 1);
  assert.equal(projection.deadlines[0].kind, 'external_task');
  assert.equal(projection.plan.status, 'proposed');
  assert.equal(projection.connectedContextSources[0].provider, 'mcp');
});

test('external task abstraction carries identity, fingerprints, link state, and conflict state', () => {
  assert.deepEqual(EXTERNAL_TASK_PROVIDER_KINDS, ['todoist', 'microsoft', 'notion']);
  assert.equal(EXTERNAL_TASK_SCHEMA_VERSION, 'external-task-v1');
  assert.equal(isKnownExternalTaskProviderKind('todoist'), true);
  assert.equal(isKnownExternalTaskProviderKind('future-task-provider'), false);
  assert.deepEqual(EXTERNAL_TASK_BOUNDARY_POLICY, {
    providerSpecificTaskFieldsAllowed: false,
    persistenceImplementationOwnedHere: false,
    conflictStateRequired: true,
  });

  const task: ExternalTaskReference = {
    version: MODULE_CONTRACT_VERSION,
    schemaVersion: EXTERNAL_TASK_SCHEMA_VERSION,
    scopeId: 'scope-a',
    taskRefId: 'task-ref-1',
    identity: {
      provider: 'notion',
      providerIdentity: {
        provider: 'notion',
        providerAccountId: 'acct-1',
        providerSpaceId: 'workspace-1',
        displayName: 'Work',
      },
      connectionId: 'conn-notion',
      externalId: 'page-1',
      externalUrl: 'https://example.invalid/page-1',
    },
    linkState: 'linked',
    syncState: 'remote_pending',
    fingerprint: {
      contentHash: 'sha256-content',
      dedupeHash: 'sha256-meaning',
      fingerprintedAt: '2026-09-16T09:00:00Z',
      dedupeKeys: ['call-bank', '2026-09-16'],
    },
    conflict: {
      state: 'remote_changed',
      detectedAt: '2026-09-16T09:01:00Z',
      localVersionHash: 'sha256-local',
      remoteVersionHash: 'sha256-remote',
      resolution: 'unresolved',
    },
    linkedCommitmentId: 'commitment-1',
    lastSyncedAt: '2026-09-16T08:30:00Z',
    detachedAt: null,
    updatedAt: '2026-09-16T09:01:00Z',
  };

  assert.equal(task.identity.externalId, 'page-1');
  assert.equal(task.fingerprint.dedupeHash, 'sha256-meaning');
  assert.equal(task.conflict.state, 'remote_changed');
});

test('foundation contract files do not define provider-specific planner or diagnosis fields', () => {
  const files = [
    'src/contracts/v1/integrationConnectionContracts.ts',
    'src/contracts/v1/readinessContracts.ts',
    'src/contracts/v1/userStateProjectionContracts.ts',
    'src/contracts/v1/externalTaskContracts.ts',
  ];
  const text = files.map(source).join('\n');

  for (const forbidden of [
    'whoopRecoveryScore',
    'whoopStrainScore',
    'healthKitPlanner',
    'healthConnectPlanner',
    'todoistPriority',
    'notionPlannerStatus',
    'microsoftImportance',
    'medicalDiagnosis',
    'diagnosticLabel',
  ]) {
    assert.equal(
      text.includes(forbidden),
      false,
      `provider-specific planner or diagnosis field leaked: ${forbidden}`,
    );
  }
});
