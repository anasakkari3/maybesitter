import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTELLIGENCE_MODULES,
  INTELLIGENCE_MODULE_CONTRACTS,
  MODULE_CONTRACT_VERSION,
  STATE_WRITE_POLICY,
  type ContractProvenance,
} from '../../src/contracts/v1/moduleContracts.ts';
import { PLANNING_SCHEMA_VERSION } from '../../src/contracts/v1/planningContracts.ts';
import { RECOMMENDATION_SCHEMA_VERSION } from '../../src/contracts/v1/recommendationContracts.ts';
import { SAFETY_SCHEMA_VERSION } from '../../src/contracts/v1/safetyContracts.ts';
import { COACHING_SCHEMA_VERSION } from '../../src/contracts/v1/coachingContracts.ts';
import { PRIORITY_SCHEMA_VERSION } from '../../src/contracts/v1/priorityContracts.ts';
import { buildHealthConnectReadinessSnapshot } from '../../lib/integrations/readiness/healthConnect.ts';
import {
  HEALTH_CONNECT_MINIMUM_READ_PERMISSIONS,
  HealthConnectReadinessAdapter,
  type HealthConnectNativePort,
} from '../../lib/integrations/healthConnect/adapter.ts';
import {
  normalizeMicrosoftTask,
  normalizeNotionTask,
  normalizeTodoistTask,
} from '../../lib/integrations/tasks/externalTaskNormalizer.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const SOURCE_ROOTS = ['src', 'lib'];

const INTELLIGENCE_IMPLEMENTATIONS = [
  'lib/services/captureService.ts',
] as const;

const FORBIDDEN_DIRECT_IMPORT_SNIPPETS = [
  "from './commandService'",
  "from '../commandService'",
  "from '../../src/server/dataStore'",
  "from '../../../src/server/dataStore'",
] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function walk(dir: string): readonly string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

function sourceFiles(): readonly string[] {
  return SOURCE_ROOTS.flatMap((dir) => walk(join(repoRoot, dir)));
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function matches(pattern: RegExp): readonly string[] {
  const found: string[] = [];
  for (const file of sourceFiles()) {
    if (pattern.test(read(file))) found.push(relative(repoRoot, file));
  }
  return found.sort();
}

test('contract registry covers all Sprint 00 intelligence modules with v1 contracts', () => {
  const names = Object.keys(INTELLIGENCE_MODULE_CONTRACTS).sort();
  assert.deepEqual(names, [...INTELLIGENCE_MODULES].sort());

  for (const moduleName of INTELLIGENCE_MODULES) {
    const contract = INTELLIGENCE_MODULE_CONTRACTS[moduleName];
    assert.equal(contract.version, MODULE_CONTRACT_VERSION);
    assert.equal(contract.module, moduleName);
    assert.equal(contract.owner, 'backend');
    assert.equal(contract.allowsDirectStateWrites, false);
  }
});

test('state-write policy is explicit and deterministic-service mediated', () => {
  assert.match(STATE_WRITE_POLICY.rule, /MAY NOT write canonical user state directly/i);
  assert.match(STATE_WRITE_POLICY.requiredPath, /deterministic service command/i);
});

test('capture and mobile capture do not import persistence internals directly', () => {
  for (const file of INTELLIGENCE_IMPLEMENTATIONS) {
    const source = readRepoFile(file);
    for (const forbidden of FORBIDDEN_DIRECT_IMPORT_SNIPPETS) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${file} must not import ${forbidden}; use deterministicStateGateway instead`
      );
    }
  }
});

test('module contracts execute with typed provenance envelope', async () => {
  const provenance: ContractProvenance = {
    traceId: 'test-trace',
    producedAt: '2026-01-01T00:00:00.000Z',
    source: 'system',
    confidence: null,
  };

  // Sprint 07 issue #30 moved `planning` from placeholder to implemented. The
  // descriptor stays a descriptor rather than a live call — modules are reached
  // through their own entry points — so what is pinned here is the entry point
  // and the schema it speaks, which is what a caller needs in order to find it.
  const result = await INTELLIGENCE_MODULE_CONTRACTS.planning.execute({
    scopeId: 'scope',
    input: { payload: {} },
    provenance,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.output, {
      status: 'implemented',
      module: 'planning',
      schemaVersion: 'planning-v1',
      entryPoint: 'lib/planning/scheduler#schedulePlan',
    });
  }

  // Sprint 08 issue #34 moved `recommendation` from placeholder to implemented,
  // on the same terms: the descriptor stays a descriptor and what is pinned is
  // the entry point and the schema it speaks.
  const recommendation = await INTELLIGENCE_MODULE_CONTRACTS.recommendation.execute({
    scopeId: 'scope',
    input: { payload: {} },
    provenance,
  });
  assert.equal(recommendation.ok, true);
  if (recommendation.ok) {
    assert.deepEqual(recommendation.output, {
      status: 'implemented',
      module: 'recommendation',
      schemaVersion: 'recommendation-v1',
      entryPoint: 'lib/recommendation#selectRecommendation',
    });
  }

  // A module still awaiting its sprint keeps the placeholder shape, so this
  // test does not quietly stop checking that the two shapes are distinct.
  // Whichever module holds this slot must be one no track has implemented — an
  // assertion that both shapes exist is worthless the moment it is made about a
  // module that has only one of them.
  //
  // The slot has moved twice for exactly that reason: `recommendation` gave it
  // up when #34 landed, `coaching` when #38 did. `feedback` holds it now, and
  // the one placeholder remaining beside it is `evaluation` — #131 moved
  // `priority` to implemented and did not need to move this slot, because the
  // slot was never `priority`'s. Checked, not assumed: `feedback` is not in the
  // shadow chain, its descriptor was not touched, and it still answers the
  // sentinel below.
  const pending = await INTELLIGENCE_MODULE_CONTRACTS.feedback.execute({
    scopeId: 'scope',
    input: { payload: {} },
    provenance,
  });
  assert.equal(pending.ok, true);
  if (pending.ok) {
    assert.deepEqual(pending.output, { status: 'not_implemented_in_sprint_00' });
  }
});

test('the recommendation module descriptor matches the recommendation schema version', async () => {
  const result = await INTELLIGENCE_MODULE_CONTRACTS.recommendation.execute({
    provenance: { traceId: 't', producedAt: '2026-08-19T00:00:00.000Z', source: 'system', confidence: null },
    input: {},
  } as never);
  assert.equal(result.ok, true);
  const output = result.ok ? (result.output as { schemaVersion: string }) : { schemaVersion: '' };
  // `moduleContracts` spells this literal out to avoid an import cycle that
  // throws at runtime while typechecking clean; this is what keeps the two
  // spellings from drifting apart. Mirrors the planning pin below.
  assert.equal(output.schemaVersion, RECOMMENDATION_SCHEMA_VERSION);
});

test('the coaching module descriptor matches the coaching schema version', async () => {
  const result = await INTELLIGENCE_MODULE_CONTRACTS.coaching.execute({
    provenance: { traceId: 't', producedAt: '2026-08-20T00:00:00.000Z', source: 'system', confidence: null },
    input: {},
  } as never);
  assert.equal(result.ok, true);
  const output = result.ok ? (result.output as { schemaVersion: string; entryPoint: string }) : { schemaVersion: '', entryPoint: '' };
  // Sprint 09 issue #38 moved `coaching` from placeholder to implemented.
  // `moduleContracts` spells the version out as a literal to avoid an import
  // cycle that throws at runtime while typechecking clean; this is what keeps
  // the two spellings from drifting apart.
  assert.equal(output.schemaVersion, COACHING_SCHEMA_VERSION);
  assert.equal(output.entryPoint, 'lib/coaching#deliverCoaching');
});

test('the safety module descriptor matches the safety schema version', async () => {
  const result = await INTELLIGENCE_MODULE_CONTRACTS.safety.execute({
    provenance: { traceId: 't', producedAt: '2026-08-20T00:00:00.000Z', source: 'system', confidence: null },
    input: {},
  } as never);
  assert.equal(result.ok, true);
  const output = result.ok ? (result.output as { schemaVersion: string; entryPoint: string }) : { schemaVersion: '', entryPoint: '' };
  // Sprint 09 issue #39 moved `safety` from placeholder to implemented.
  // `moduleContracts` spells the version out as a literal to avoid an import
  // cycle that throws at runtime while typechecking clean; this is what keeps
  // the two spellings from drifting apart. Mirrors the recommendation and
  // planning pins above.
  assert.equal(output.schemaVersion, SAFETY_SCHEMA_VERSION);
  assert.equal(output.entryPoint, 'lib/safety#evaluateSafetyGate');
});

test('the priority module descriptor matches the priority schema version', async () => {
  const result = await INTELLIGENCE_MODULE_CONTRACTS.priority.execute({
    provenance: { traceId: 't', producedAt: '2026-09-24T00:00:00.000Z', source: 'system', confidence: null },
    input: {},
  } as never);
  assert.equal(result.ok, true);
  const output = result.ok
    ? (result.output as { status: string; schemaVersion: string; entryPoint: string })
    : { status: '', schemaVersion: '', entryPoint: '' };
  // Issue #131 moved `priority` from placeholder to implemented. `moduleContracts`
  // spells the version out as a literal like its siblings (see the comment
  // there for why the cycle is prospective for priority rather than present);
  // this is what keeps the two spellings from drifting apart.
  assert.equal(output.status, 'implemented');
  assert.equal(output.schemaVersion, PRIORITY_SCHEMA_VERSION);
  assert.equal(output.entryPoint, 'lib/priority/priorityScorer#rankPriorities');
});

test('the planning module descriptor matches the planning schema version', async () => {
  const result = await INTELLIGENCE_MODULE_CONTRACTS.planning.execute({
    provenance: { traceId: 't', producedAt: '2026-08-19T00:00:00.000Z', source: 'system', confidence: null },
    input: {},
  } as never);
  assert.equal(result.ok, true);
  const output = result.ok ? (result.output as { schemaVersion: string }) : { schemaVersion: '' };
  // `moduleContracts` spells this literal out to avoid an import cycle that
  // throws at runtime while typechecking clean; this is what keeps the two
  // spellings from drifting apart. Mirrors the decomposition pin in
  // tests/decomposition/decompositionCrossTrack.test.ts.
  assert.equal(output.schemaVersion, PLANNING_SCHEMA_VERSION);
});

test('there is one canonical planner entry point', () => {
  assert.deepEqual(matches(/\bexport function schedulePlan\b/), [
    'lib/planning/scheduler/scheduler.ts',
  ]);
});

test('there is one canonical runtime memory contract and storage implementation', () => {
  assert.deepEqual(matches(/\bexport interface RuntimeMemoryStore\b/), [
    'src/contracts/v1/memoryContracts.ts',
  ]);
  assert.deepEqual(matches(/\bexport class StorageRuntimeMemoryStore\b/), [
    'lib/runtimeMemory/runtimeMemoryStore.ts',
  ]);
  assert.deepEqual(matches(/\bexport function createStorageRuntimeMemoryStore\b/), [
    'lib/runtimeMemory/runtimeMemoryStore.ts',
  ]);
});

test('provider names do not couple directly to planner internals', () => {
  const plannerFiles = sourceFiles().filter((file) => {
    const rel = relative(repoRoot, file);
    return rel.startsWith('lib/planning/scheduler/') || rel.startsWith('lib/planning/constraints/');
  });
  const providerPattern = /\b(healthkit|health_connect|whoop|todoist|notion|gmail|outlook|microsoft_graph|rescuetime)\b/i;
  const coupled = plannerFiles
    .filter((file) => providerPattern.test(read(file)))
    .map((file) => relative(repoRoot, file));

  assert.deepEqual(coupled, []);
});

test('provider adapters cannot introduce a private planner or memory store by name', () => {
  const providerLikeFiles = sourceFiles().filter((file) => {
    const rel = relative(repoRoot, file).toLowerCase();
    return /(provider|adapter|integration|oauth|mcp|whoop|todoist|notion|gmail|outlook|microsoft|healthkit|healthconnect)/.test(rel);
  });

  const duplicateSystemPattern =
    /\b(class|interface|function)\s+(WhoopPlanner|HealthKitPlanner|HealthConnectPlanner|GmailPlanner|TodoistPlanner|NotionPlanner|MicrosoftPlanner|ProviderMemoryStore|IntegrationMemoryStore)\b/;
  const duplicates = providerLikeFiles
    .filter((file) => duplicateSystemPattern.test(read(file)))
    .map((file) => relative(repoRoot, file));

  assert.deepEqual(duplicates, []);
});

test('Health Connect native readings normalize through the provider-independent readiness contract', () => {
  const snapshot = buildHealthConnectReadinessSnapshot({
    scopeId: 'scope-a',
    computedAt: '2026-09-16T09:00:00Z',
    windowStart: '2026-09-15T09:00:00Z',
    windowEnd: '2026-09-16T09:00:00Z',
    sleep: {
      observedAt: '2026-09-16T06:30:00Z',
      sleepStart: '2026-09-15T23:15:00Z',
      sleepEnd: '2026-09-16T06:15:00Z',
      totalSleepMinutes: null,
    },
    heart: {
      observedAt: '2026-09-16T06:15:00Z',
      restingHeartRate: 61,
      hrvMilliseconds: 40,
    },
    steps: {
      observedAt: '2026-09-15T21:00:00Z',
      count: 7250,
    },
  });

  assert.equal(snapshot.schemaVersion, 'readiness-v1');
  assert.deepEqual(snapshot.sourceKinds, ['health_connect']);
  assert.equal(snapshot.score, 0.875);
  assert.equal(snapshot.band, 'high');
  assert.equal(snapshot.normalizedSignals.sleepDurationMinutes, 420);
  assert.equal(snapshot.normalizedSignals.restingHeartRate, 61);
  assert.equal(snapshot.normalizedSignals.hrv, 40);
  assert.equal(snapshot.normalizedSignals.recentActivityLoad, 0.725);
  assert.equal(snapshot.subjective, null);
  assert.deepEqual(snapshot.missingSourceKinds, []);
  assert.ok(snapshot.signals.every((signal) => signal.source.kind === 'health_connect'));
  assert.ok(snapshot.signals.every((signal) => signal.source.provider === undefined));
  assert.equal(snapshot.signals.some((signal) => signal.metric === 'steps'), true);
  assert.equal(JSON.stringify(snapshot).includes('HealthConnectPlanner'), false);
});

function healthConnectPort(
  overrides: Partial<HealthConnectNativePort> = {},
): HealthConnectNativePort {
  const authorization = {
    state: 'authorized' as const,
    granted: HEALTH_CONNECT_MINIMUM_READ_PERMISSIONS,
    denied: [],
    checkedAt: '2026-09-16T09:00:00Z',
  };
  return {
    isSdkAvailable: async () => true,
    authorization: async () => authorization,
    requestAuthorization: async () => authorization,
    readRecords: async () => ({
      sleep: {
        observedAt: '2026-09-16T06:30:00Z',
        sleepStart: '2026-09-15T23:00:00Z',
        sleepEnd: '2026-09-16T06:30:00Z',
        totalSleepMinutes: 450,
      },
      steps: { observedAt: '2026-09-16T08:00:00Z', count: 4200 },
    }),
    revokeAllPermissions: async () => undefined,
    clearLocalConnection: async () => undefined,
    ...overrides,
  };
}

const healthConnectWindow = {
  scopeId: 'scope-a',
  computedAt: '2026-09-16T09:00:00Z',
  windowStart: '2026-09-15T09:00:00Z',
  windowEnd: '2026-09-16T09:00:00Z',
} as const;

test('Health Connect adapter requests only the canonical minimum read permissions', async () => {
  let requested: readonly string[] = [];
  const port = healthConnectPort({
    authorization: async () => ({
      state: 'not_determined', granted: [], denied: [], checkedAt: healthConnectWindow.computedAt,
    }),
    requestAuthorization: async (permissions) => {
      requested = permissions;
      return {
        state: 'authorized', granted: permissions, denied: [], checkedAt: healthConnectWindow.computedAt,
      };
    },
  });

  const result = await new HealthConnectReadinessAdapter(port).authorize();

  assert.equal(result.state, 'authorized');
  assert.deepEqual(requested, HEALTH_CONNECT_MINIMUM_READ_PERMISSIONS);
});

test('Health Connect adapter reports fresh, stale, empty, and denied reads without provider leakage', async () => {
  const fresh = await new HealthConnectReadinessAdapter(healthConnectPort(), {
    connectionId: 'int-health-connect',
  }).collect(healthConnectWindow);
  const stale = await new HealthConnectReadinessAdapter(healthConnectPort({
    readRecords: async () => ({
      sleep: {
        observedAt: '2026-09-13T06:30:00Z',
        sleepStart: '2026-09-12T23:00:00Z',
        sleepEnd: '2026-09-13T06:30:00Z',
        totalSleepMinutes: 450,
      },
    }),
  })).collect(healthConnectWindow);
  const empty = await new HealthConnectReadinessAdapter(healthConnectPort({
    readRecords: async () => ({}),
  })).collect(healthConnectWindow);
  const denied = await new HealthConnectReadinessAdapter(healthConnectPort({
    authorization: async () => ({
      state: 'denied', granted: [], denied: HEALTH_CONNECT_MINIMUM_READ_PERMISSIONS,
      checkedAt: healthConnectWindow.computedAt,
    }),
  })).collect(healthConnectWindow);

  assert.equal(fresh.state, 'fresh');
  assert.equal(fresh.provenance.connectionId, 'int-health-connect');
  assert.equal(fresh.provenance.rawPayloadPersisted, false);
  assert.equal(fresh.snapshot?.sourceKinds[0], 'health_connect');
  assert.equal(stale.state, 'stale');
  assert.equal(empty.state, 'empty');
  assert.equal(denied.state, 'permission_denied');
  assert.equal(denied.snapshot, null);
});

test('Health Connect adapter converts native failures to a stable privacy-safe result', async () => {
  const events: unknown[] = [];
  const adapter = new HealthConnectReadinessAdapter(healthConnectPort({
    readRecords: async () => { throw new Error('raw provider payload must not escape'); },
  }), { logger: { log: (event) => events.push(event) } });

  const result = await adapter.collect(healthConnectWindow);

  assert.equal(result.state, 'error');
  assert.equal(result.errorCode, 'health_connect_read_failed');
  assert.equal(JSON.stringify(events).includes('raw provider payload'), false);
});

test('Health Connect disconnect revokes provider permission and clears local connection', async () => {
  const calls: string[] = [];
  const adapter = new HealthConnectReadinessAdapter(healthConnectPort({
    revokeAllPermissions: async () => { calls.push('revoke'); },
    clearLocalConnection: async () => { calls.push('clear'); },
  }));

  const result = await adapter.disconnect();

  assert.deepEqual(calls, ['revoke', 'clear']);
  assert.deepEqual(result, {
    localConnectionCleared: true,
    providerPermissionRevocation: 'revoked',
  });
});

test('external task provider payloads normalize to one task reference contract', () => {
  const providerIdentity = {
    provider: 'todoist',
    providerAccountId: 'acct-1',
    providerSpaceId: null,
    displayName: 'Tasks',
  } as const;
  const base = {
    scopeId: 'scope-a',
    connectionId: 'conn-task',
    providerIdentity,
    externalId: 'task-1',
    title: '  Call the school office  ',
    notes: 'Ask about pickup forms',
    dueAt: '2026-09-17T09:00:00.000Z',
    completed: false,
    updatedAt: '2026-09-16T09:00:00.000Z',
  };

  const todoist = normalizeTodoistTask(base);
  const notion = normalizeNotionTask({
    ...base,
    providerIdentity: { ...providerIdentity, provider: 'notion', providerSpaceId: 'workspace-1' },
    externalId: 'page-1',
    externalUrl: 'https://example.invalid/page-1',
  });
  const microsoft = normalizeMicrosoftTask({
    ...base,
    providerIdentity: { ...providerIdentity, provider: 'microsoft' },
    externalId: 'todo-1',
    title: 'Call the school office',
  });

  assert.equal(todoist.schemaVersion, 'external-task-v1');
  assert.equal(todoist.identity.provider, 'todoist');
  assert.equal(notion.identity.provider, 'notion');
  assert.equal(microsoft.identity.provider, 'microsoft');
  assert.equal(todoist.linkState, 'candidate');
  assert.equal(todoist.syncState, 'remote_pending');
  assert.equal(todoist.conflict.state, 'none');
  assert.deepEqual(todoist.fingerprint.dedupeKeys, [
    'title:call the school office',
    'due:2026-09-17',
  ]);
  assert.equal(todoist.fingerprint.dedupeHash, notion.fingerprint.dedupeHash);
  assert.equal(todoist.fingerprint.dedupeHash, microsoft.fingerprint.dedupeHash);
  assert.notEqual(todoist.fingerprint.contentHash, notion.fingerprint.contentHash);
  assert.notEqual(todoist.taskRefId, notion.taskRefId);
});
