import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');

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
  // `coaching` is Sprint 09's; it replaced `recommendation` here when #34
  // landed, and whichever module holds this slot must be one no track has
  // implemented — an assertion that both shapes exist is worthless the moment
  // it is made about a module that has only one of them.
  const pending = await INTELLIGENCE_MODULE_CONTRACTS.coaching.execute({
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
