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

test('placeholder module contracts execute with typed provenance envelope', async () => {
  const provenance: ContractProvenance = {
    traceId: 'test-trace',
    producedAt: '2026-01-01T00:00:00.000Z',
    source: 'system',
    confidence: null,
  };

  const result = await INTELLIGENCE_MODULE_CONTRACTS.planning.execute({
    scopeId: 'scope',
    input: { payload: {} },
    provenance,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.output, { status: 'not_implemented_in_sprint_00' });
  }
});
