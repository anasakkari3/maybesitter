import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTELLIGENCE_MODULES,
  MODULE_CONTRACT_VERSION,
} from '../../src/contracts/v1/moduleContracts.ts';
import { buildHealthKitReadinessSnapshot } from '../../lib/integrations/readiness/healthkit.ts';
import {
  HEALTHKIT_MINIMUM_READ_PERMISSIONS,
  HealthKitReadinessAdapter,
  type HealthKitAuthorizationSnapshot,
  type HealthKitNativePort,
  type HealthKitSampleWindow,
} from '../../lib/integrations/healthkit/adapter.ts';
import type { PrivacySafeNativeReadinessLog } from '../../lib/integrations/readiness/nativeAdapterContracts.ts';
import { buildWhoopReadinessSnapshot } from '../../lib/integrations/readiness/whoop.ts';
import {
  WHOOP_OAUTH_SCOPES,
  buildWhoopConnectionInput,
  buildWhoopDisconnectRequest,
  planWhoopReadinessSync,
  tokenState,
  withWhoopReadinessProvenance,
  type WhoopTokenSetMetadata,
} from '../../lib/integrations/whoop/backend.ts';
import { MemoryIntegrationConnectionStore } from '../../lib/integrations/connections/connectionRegistry.ts';
import {
  MemoryProviderOAuthStateStore,
  ProviderOAuthError,
  beginProviderOAuth,
  completeProviderOAuth,
  disconnectProviderOAuth,
  type ProviderOAuthClient,
} from '../../lib/integrations/providers/providerOAuthLifecycle.ts';
import type {
  ProviderCredentialVault,
  ProviderOAuthTokenSet,
} from '../../lib/integrations/providers/providerRuntime.ts';
import {
  CONTEXT_PROVIDER_KINDS,
  INTEGRATION_CONNECTION_CONTRACT_VERSION,
  INTEGRATION_CONNECTION_SCHEMA_VERSION,
  isKnownContextProviderKind,
  type ContextProviderKind,
  type IntegrationCredentialReference,
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

const OAUTH_NOW = '2026-09-17T08:00:00.000Z';
const OAUTH_TOKEN: ProviderOAuthTokenSet = Object.freeze({
  accessToken: 'access-token-secret',
  refreshToken: 'refresh-token-secret',
  accessTokenExpiresAt: '2026-09-17T09:00:00.000Z',
  refreshTokenExpiresAt: null,
  grantedScopes: Object.freeze(['mail.read']),
});

class TestProviderCredentialVault implements ProviderCredentialVault {
  readonly values = new Map<string, ProviderOAuthTokenSet>();
  readonly deleted: string[] = [];

  async storeOAuthTokenSet(input: {
    readonly scopeId: string;
    readonly provider: ContextProviderKind;
    readonly tokenSet: ProviderOAuthTokenSet;
  }): Promise<IntegrationCredentialReference> {
    const keyId = `${input.scopeId}:${input.provider}`;
    this.values.set(keyId, input.tokenSet);
    return { vault: 'test-vault', keyId, version: '1' };
  }

  async loadOAuthTokenSet(reference: IntegrationCredentialReference): Promise<ProviderOAuthTokenSet | null> {
    return this.values.get(reference.keyId) ?? null;
  }

  async delete(reference: IntegrationCredentialReference): Promise<void> {
    this.deleted.push(reference.keyId);
    this.values.delete(reference.keyId);
  }
}

function oauthClient(overrides: Partial<ProviderOAuthClient> = {}): ProviderOAuthClient {
  return {
    provider: 'google',
    exchangeAuthorizationCode: async () => OAUTH_TOKEN,
    loadIdentity: async () => ({
      provider: 'google',
      providerAccountId: 'google-account-1',
      providerSpaceId: null,
      displayName: 'Connected Google account',
    }),
    revoke: async () => undefined,
    ...overrides,
  };
}

async function beginGoogleOAuth(states: MemoryProviderOAuthStateStore) {
  return beginProviderOAuth(states, {
    scopeId: 'user-a',
    provider: 'google',
    capabilities: ['mail_read'],
    requestedScopes: ['mail.read'],
    authorizationEndpoint: 'https://accounts.example.test/oauth/authorize',
    clientId: 'public-client-id',
    redirectUri: 'https://app.example.test/api/oauth/callback',
    now: OAUTH_NOW,
  }, (size) => Buffer.alloc(size, size));
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
    // A financial source (#financial-v1). Its own kind rather than a real
    // aggregator's name, because this vocabulary is what a connection record
    // is stamped with and what the Trust Center shows, and a record reading
    // `plaid` while nothing has ever spoken to Plaid would be wrong in the one
    // place somebody checks what is attached to their money.
    'financial_sandbox',
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

test('HealthKit native readings normalize without provider-specific planner fields', () => {
  const snapshot = buildHealthKitReadinessSnapshot({
    scopeId: 'scope-a',
    computedAt: '2026-09-16T09:00:00Z',
    windowStart: '2026-09-15T09:00:00Z',
    windowEnd: '2026-09-16T09:00:00Z',
    sleep: {
      observedAt: '2026-09-16T06:30:00Z',
      sleepStart: '2026-09-15T22:45:00Z',
      sleepEnd: '2026-09-16T06:45:00Z',
      totalSleepMinutes: null,
    },
    heart: {
      observedAt: '2026-09-16T06:45:00Z',
      restingHeartRate: 56,
      hrvMilliseconds: 48,
    },
    activity: {
      observedAt: '2026-09-15T21:30:00Z',
      stepCount: 6500,
    },
  });

  assert.equal(snapshot.schemaVersion, READINESS_SCHEMA_VERSION);
  assert.deepEqual(snapshot.sourceKinds, ['healthkit']);
  assert.equal(snapshot.score, 1);
  assert.equal(snapshot.band, 'high');
  assert.equal(snapshot.normalizedSignals.sleepDurationMinutes, 480);
  assert.equal(snapshot.normalizedSignals.restingHeartRate, 56);
  assert.equal(snapshot.normalizedSignals.hrv, 48);
  assert.equal(snapshot.normalizedSignals.recentActivityLoad, 0.65);
  assert.equal(snapshot.subjective, null);
  assert.deepEqual(snapshot.missingSourceKinds, []);
  assert.ok(snapshot.signals.every((signal) => signal.source.kind === 'healthkit'));
  assert.ok(snapshot.signals.every((signal) => signal.source.provider === undefined));
  assert.equal(snapshot.signals.some((signal) => signal.metric === 'steps'), true);
  assert.equal(JSON.stringify(snapshot).includes('HealthKitPlanner'), false);
});

test('WHOOP backend prep keeps OAuth, sync, revoke, and provenance provider-boundary safe', () => {
  const now = '2026-09-16T09:00:00Z';
  const token: WhoopTokenSetMetadata = {
    accessTokenExpiresAt: '2026-09-16T10:00:00Z',
    refreshTokenExpiresAt: '2026-10-16T10:00:00Z',
    grantedScopes: WHOOP_OAUTH_SCOPES,
    hasRefreshToken: true,
  };

  const input = buildWhoopConnectionInput(
    'scope-a',
    { whoopUserId: 'whoop-user-1', displayName: 'WHOOP Account' },
    token,
    now,
  );

  assert.equal(input.identity.provider, 'whoop');
  assert.equal(input.identity.providerAccountId, 'whoop-user-1');
  assert.deepEqual(input.capabilities, ['readiness_read']);
  assert.equal(input.state, 'connected');
  assert.equal('accessToken' in input, false);
  assert.equal('refreshToken' in input, false);
  assert.equal(tokenState(token, now), 'active');
  assert.equal(tokenState({ ...token, accessTokenExpiresAt: '2026-09-16T09:05:00Z' }, now), 'refresh_due');
  assert.equal(tokenState({ ...token, refreshTokenExpiresAt: '2026-09-16T08:59:00Z' }, now), 'revoked');

  const connection: IntegrationConnectionRecord = {
    version: INTEGRATION_CONNECTION_CONTRACT_VERSION,
    schemaVersion: INTEGRATION_CONNECTION_SCHEMA_VERSION,
    connectionId: 'conn-whoop',
    scopeId: 'scope-a',
    identity: input.identity,
    state: 'connected',
    capabilities: input.capabilities,
    grantedScopes: input.grantedScopes ?? [],
    connectedAt: now,
    lastSyncedAt: '2026-09-16T07:00:00Z',
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    updatedAt: now,
  };

  const plan = planWhoopReadinessSync(
    connection,
    token,
    '2026-09-15T09:00:00Z',
    '2026-09-16T09:00:00Z',
    now,
  );
  assert.equal(plan.shouldSync, true);
  assert.equal(plan.reason, 'ready');
  assert.equal(plan.cursor?.lastSyncedAt, '2026-09-16T07:00:00Z');

  const blocked = planWhoopReadinessSync(
    { ...connection, capabilities: [] },
    token,
    '2026-09-15T09:00:00Z',
    '2026-09-16T09:00:00Z',
    now,
  );
  assert.equal(blocked.shouldSync, false);
  assert.equal(blocked.reason, 'missing_readiness_capability');

  const revoke = buildWhoopDisconnectRequest('conn-whoop', now);
  assert.deepEqual(revoke, {
    provider: 'whoop',
    connectionId: 'conn-whoop',
    revokeProviderToken: true,
    markConnectionState: 'revoked',
    requestedAt: now,
  });

  const readiness = buildWhoopReadinessSnapshot({
    scopeId: 'scope-a',
    computedAt: now,
    windowStart: '2026-09-15T09:00:00Z',
    windowEnd: '2026-09-16T09:00:00Z',
    connectionId: 'conn-whoop',
    recovery: {
      observedAt: '2026-09-16T06:30:00Z',
      recoveryScore: 70,
      restingHeartRate: 57,
      hrvMilliseconds: 44,
    },
  });

  const withProvenance = withWhoopReadinessProvenance(readiness, 'conn-whoop');
  assert.equal(withProvenance.provenance.provider, 'whoop');
  assert.deepEqual(withProvenance.provenance.sourcePrecedence, [
    'subjective',
    'whoop',
    'healthkit',
    'health_connect',
  ]);
  assert.equal(
    withProvenance.provenance.duplicatePolicy,
    'prefer_connected_whoop_recovery_then_native_sleep',
  );
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

const HEALTHKIT_NOW = '2026-09-16T12:00:00.000Z';

class FakeHealthKitPort implements HealthKitNativePort {
  available = true;
  reads = 0;
  disconnected = false;
  authorizationState: HealthKitAuthorizationSnapshot = {
    state: 'authorized',
    granted: HEALTHKIT_MINIMUM_READ_PERMISSIONS,
    denied: [],
    checkedAt: HEALTHKIT_NOW,
  };

  async isAvailable(): Promise<boolean> { return this.available; }
  async authorization(): Promise<HealthKitAuthorizationSnapshot> { return this.authorizationState; }
  async requestAuthorization(): Promise<HealthKitAuthorizationSnapshot> { return this.authorizationState; }
  async readSamples(_window: HealthKitSampleWindow) {
    this.reads += 1;
    return {
      sleep: {
        observedAt: '2026-09-16T08:00:00.000Z',
        sleepStart: '2026-09-15T23:00:00.000Z',
        sleepEnd: '2026-09-16T07:00:00.000Z',
        totalSleepMinutes: 480,
      },
      heart: {
        observedAt: '2026-09-16T08:05:00.000Z',
        restingHeartRate: 58,
        hrvMilliseconds: 44,
      },
      activity: { observedAt: '2026-09-16T08:10:00.000Z', stepCount: 2200 },
    };
  }
  async clearLocalConnection(): Promise<void> { this.disconnected = true; }
}

function healthKitRequest() {
  return {
    scopeId: 'scope-1',
    computedAt: HEALTHKIT_NOW,
    windowStart: '2026-09-15T12:00:00.000Z',
    windowEnd: HEALTHKIT_NOW,
  };
}

test('HealthKit reads minimal permissions and normalizes fresh samples', async () => {
  const port = new FakeHealthKitPort();
  const logs: PrivacySafeNativeReadinessLog[] = [];
  const adapter = new HealthKitReadinessAdapter(port, {
    connectionId: 'int-healthkit',
    logger: { log: (event) => logs.push(event) },
  });
  const result = await adapter.collect(healthKitRequest());

  assert.equal(result.state, 'fresh');
  assert.equal(result.snapshot?.normalizedSignals.sleepDurationMinutes, 480);
  assert.equal(result.snapshot?.normalizedSignals.restingHeartRate, 58);
  assert.equal(result.snapshot?.normalizedSignals.hrv, 44);
  assert.equal(result.provenance.rawPayloadPersisted, false);
  assert.deepEqual(HEALTHKIT_MINIMUM_READ_PERMISSIONS, [
    'sleep_analysis',
    'resting_heart_rate',
    'heart_rate_variability_sdnn',
    'step_count',
  ]);
  assert.equal('nativeValue' in logs[0]!, false);
  assert.equal('rawPayload' in logs[0]!, false);
});

test('denied HealthKit access fails closed without reading samples', async () => {
  const port = new FakeHealthKitPort();
  port.authorizationState = {
    state: 'denied',
    granted: [],
    denied: ['sleep_analysis'],
    checkedAt: HEALTHKIT_NOW,
  };
  const result = await new HealthKitReadinessAdapter(port).collect(healthKitRequest());

  assert.equal(result.state, 'permission_denied');
  assert.equal(result.snapshot, null);
  assert.equal(port.reads, 0);
});

test('old HealthKit samples remain stale context', async () => {
  const port = new FakeHealthKitPort();
  const result = await new HealthKitReadinessAdapter(port, { staleAfterMs: 60 * 60 * 1000 })
    .collect(healthKitRequest());

  assert.equal(result.state, 'stale');
  assert.equal(result.snapshot?.sourceKinds[0], 'healthkit');
});

test('HealthKit failures expose a safe error category', async () => {
  const port = new FakeHealthKitPort();
  port.readSamples = async () => { throw new Error('private sample payload'); };
  const result = await new HealthKitReadinessAdapter(port).collect(healthKitRequest());

  assert.equal(result.state, 'error');
  assert.equal(result.errorCode, 'healthkit_read_failed');
  assert.equal(JSON.stringify(result).includes('private sample payload'), false);
});

test('HealthKit disconnect records the iOS settings revocation limitation', async () => {
  const port = new FakeHealthKitPort();
  const result = await new HealthKitReadinessAdapter(port).disconnect();

  assert.equal(port.disconnected, true);
  assert.deepEqual(result, {
    localConnectionCleared: true,
    providerPermissionRevocation: 'ios_settings_required',
  });
});

test('provider OAuth begin creates a bounded PKCE URL without exposing verifier material', async () => {
  const states = new MemoryProviderOAuthStateStore();
  const result = await beginGoogleOAuth(states);
  const url = new URL(result.authorizationUrl);

  assert.equal(url.origin + url.pathname, 'https://accounts.example.test/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'public-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.test/api/oauth/callback');
  assert.equal(url.searchParams.get('scope'), 'mail.read');
  assert.equal(url.searchParams.get('state'), result.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge')!.length >= 43);
  assert.equal(result.expiresAt, '2026-09-17T08:10:00.000Z');
  assert.equal(result.authorizationUrl.includes('access-token-secret'), false);
  assert.equal(result.authorizationUrl.includes('refresh-token-secret'), false);
});

test('provider OAuth completion stores credentials only in the vault and rejects replay', async () => {
  const states = new MemoryProviderOAuthStateStore();
  const vault = new TestProviderCredentialVault();
  const connections = new MemoryIntegrationConnectionStore();
  const begin = await beginGoogleOAuth(states);

  const record = await completeProviderOAuth(states, vault, connections, oauthClient(), {
    scopeId: 'user-a',
    provider: 'google',
    state: begin.state,
    code: 'authorization-code',
    now: '2026-09-17T08:01:00.000Z',
  });

  assert.equal(record.identity.provider, 'google');
  assert.equal(record.state, 'connected');
  assert.deepEqual(record.capabilities, ['mail_read']);
  assert.deepEqual(record.grantedScopes, ['mail.read']);
  assert.equal(record.credentialRef?.vault, 'test-vault');
  assert.equal(vault.values.get('user-a:google')?.accessToken, 'access-token-secret');
  assert.equal(JSON.stringify(record).includes('access-token-secret'), false);
  assert.equal(JSON.stringify(record).includes('refresh-token-secret'), false);

  await assert.rejects(
    completeProviderOAuth(states, vault, connections, oauthClient(), {
      scopeId: 'user-a',
      provider: 'google',
      state: begin.state,
      code: 'authorization-code',
      now: '2026-09-17T08:02:00.000Z',
    }),
    (error) => error instanceof ProviderOAuthError && error.code === 'invalid_or_replayed_state',
  );
});

test('provider OAuth callback refuses mismatched or expired state without replaying it', async () => {
  const states = new MemoryProviderOAuthStateStore();
  const vault = new TestProviderCredentialVault();
  const connections = new MemoryIntegrationConnectionStore();
  const begin = await beginGoogleOAuth(states);

  await assert.rejects(
    completeProviderOAuth(states, vault, connections, oauthClient(), {
      scopeId: 'other-user',
      provider: 'google',
      state: begin.state,
      code: 'authorization-code',
      now: '2026-09-17T08:01:00.000Z',
    }),
    (error) => error instanceof ProviderOAuthError && error.code === 'state_scope_mismatch',
  );
  await assert.rejects(
    completeProviderOAuth(states, vault, connections, oauthClient(), {
      scopeId: 'user-a',
      provider: 'google',
      state: begin.state,
      code: 'authorization-code',
      now: '2026-09-17T08:01:01.000Z',
    }),
    (error) => error instanceof ProviderOAuthError && error.code === 'invalid_or_replayed_state',
  );

  const expired = await beginProviderOAuth(states, {
    scopeId: 'user-a',
    provider: 'google',
    capabilities: ['mail_read'],
    requestedScopes: ['mail.read'],
    authorizationEndpoint: 'https://accounts.example.test/oauth/authorize',
    clientId: 'public-client-id',
    redirectUri: 'https://app.example.test/api/oauth/callback',
    now: OAUTH_NOW,
    stateTtlMs: 1000,
  }, (size) => Buffer.alloc(size, 7));

  await assert.rejects(
    completeProviderOAuth(states, vault, connections, oauthClient(), {
      scopeId: 'user-a',
      provider: 'google',
      state: expired.state,
      code: 'authorization-code',
      now: '2026-09-17T08:00:01.000Z',
    }),
    (error) => error instanceof ProviderOAuthError && error.code === 'invalid_or_replayed_state',
  );
});

test('provider OAuth completion compensates if the connection registry write fails', async () => {
  class FailingConnectionStore extends MemoryIntegrationConnectionStore {
    override async upsert(): Promise<IntegrationConnectionRecord> {
      throw new Error('connection store unavailable');
    }
  }

  const states = new MemoryProviderOAuthStateStore();
  const vault = new TestProviderCredentialVault();
  const begin = await beginGoogleOAuth(states);

  await assert.rejects(
    completeProviderOAuth(states, vault, new FailingConnectionStore(), oauthClient(), {
      scopeId: 'user-a',
      provider: 'google',
      state: begin.state,
      code: 'authorization-code',
      now: '2026-09-17T08:01:00.000Z',
    }),
    (error) => error instanceof ProviderOAuthError && error.code === 'connection_store_failed',
  );
  assert.deepEqual(vault.deleted, ['user-a:google']);
  assert.equal(vault.values.has('user-a:google'), false);
});

test('provider OAuth disconnect revokes before deleting credentials and preserves retry state on failure', async () => {
  const states = new MemoryProviderOAuthStateStore();
  const vault = new TestProviderCredentialVault();
  const connections = new MemoryIntegrationConnectionStore();
  const begin = await beginGoogleOAuth(states);
  let revocations = 0;
  const client = oauthClient({ revoke: async () => { revocations += 1; } });
  const record = await completeProviderOAuth(states, vault, connections, client, {
    scopeId: 'user-a',
    provider: 'google',
    state: begin.state,
    code: 'authorization-code',
    now: '2026-09-17T08:01:00.000Z',
  });

  const revoked = await disconnectProviderOAuth(vault, connections, client, {
    scopeId: 'user-a',
    connectionId: record.connectionId,
    now: '2026-09-17T08:03:00.000Z',
  });
  assert.equal(revocations, 1);
  assert.equal(revoked?.state, 'revoked');
  assert.equal(vault.values.has('user-a:google'), false);

  const retryStates = new MemoryProviderOAuthStateStore();
  const retryVault = new TestProviderCredentialVault();
  const retryConnections = new MemoryIntegrationConnectionStore();
  const retryBegin = await beginProviderOAuth(retryStates, {
    scopeId: 'user-b',
    provider: 'google',
    capabilities: ['mail_read'],
    requestedScopes: ['mail.read'],
    authorizationEndpoint: 'https://accounts.example.test/oauth/authorize',
    clientId: 'public-client-id',
    redirectUri: 'https://app.example.test/api/oauth/callback',
    now: OAUTH_NOW,
  }, (size) => Buffer.alloc(size, 9));
  const retryRecord = await completeProviderOAuth(retryStates, retryVault, retryConnections, client, {
    scopeId: 'user-b',
    provider: 'google',
    state: retryBegin.state,
    code: 'authorization-code',
    now: '2026-09-17T08:01:00.000Z',
  });

  await assert.rejects(
    disconnectProviderOAuth(retryVault, retryConnections, oauthClient({
      revoke: async () => { throw new Error('provider revoke failed'); },
    }), {
      scopeId: 'user-b',
      connectionId: retryRecord.connectionId,
      now: '2026-09-17T08:03:00.000Z',
    }),
    (error) => error instanceof ProviderOAuthError && error.code === 'revocation_failed',
  );
  assert.equal((await retryConnections.get(retryRecord.connectionId))?.state, 'error');
  assert.equal(retryVault.values.has('user-b:google'), true);
});
