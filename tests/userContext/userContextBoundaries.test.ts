import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveContextEnrichmentRuntime } from '../../lib/userContext/contextRuntime.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('context enrichment is default-off, kill-switchable, and hard-locked in production', () => {
  const defaultDecision = resolveContextEnrichmentRuntime({ MAYBESITTER_ENV: 'staging' });
  assert.equal(defaultDecision.mode, 'rules_only');
  if (defaultDecision.mode === 'rules_only') assert.equal(defaultDecision.reason, 'feature_disabled');

  const enabled = resolveContextEnrichmentRuntime({
    MAYBESITTER_ENV: 'staging',
    MAYBESITTER_FEATURE_CONTEXT_ENRICHMENT: 'true',
    MAYBESITTER_KILL_SWITCH_CONTEXT_ENRICHMENT: 'false',
  });
  assert.equal(enabled.mode, 'enabled');

  const killed = resolveContextEnrichmentRuntime({
    MAYBESITTER_ENV: 'staging',
    MAYBESITTER_FEATURE_CONTEXT_ENRICHMENT: 'true',
    MAYBESITTER_KILL_SWITCH_CONTEXT_ENRICHMENT: 'true',
  });
  assert.equal(killed.mode, 'rules_only');
  if (killed.mode === 'rules_only') assert.equal(killed.reason, 'kill_switch_active');

  const production = resolveContextEnrichmentRuntime({
    MAYBESITTER_ENV: 'production',
    MAYBESITTER_FEATURE_CONTEXT_ENRICHMENT: 'true',
    MAYBESITTER_KILL_SWITCH_CONTEXT_ENRICHMENT: 'false',
  });
  assert.equal(production.mode, 'rules_only');
  if (production.mode === 'rules_only') assert.equal(production.reason, 'release_locked');
});

test('the pure builder has no ambient clock, randomness, storage, provider, or model dependency', () => {
  const builder = read('lib/userContext/buildUserContextSnapshot.ts');
  for (const forbidden of [
    /Date\.now\s*\(/,
    /new Date\s*\(/,
    /randomUUID/,
    /Math\.random/,
    /localeCompare/,
    /getStorage/,
    /firebase/i,
    /google/i,
    /vertex/i,
    /gemini/i,
  ]) {
    assert.doesNotMatch(builder, forbidden);
  }

  const contract = read('src/contracts/v1/userContextContracts.ts');
  assert.doesNotMatch(contract, /from ['"](?:\.\.\/|lib\/)/);
});

test('context enrichment is not inserted into the recurring shadow pipeline', () => {
  const shadow = read('src/contracts/v1/shadowPipelineContracts.ts');
  assert.doesNotMatch(shadow, /SHADOW_PIPELINE_CHAIN[\s\S]{0,1000}contextEnrichment/);
});

test('deployment config keeps staging off and production off plus killed', () => {
  const flags = join(root, 'infra', 'cloudrun', 'flags.sh');
  const staging = execFileSync('bash', [flags, 'staging'], { encoding: 'utf8' });
  const production = execFileSync('bash', [flags, 'production'], { encoding: 'utf8' });

  assert.match(staging, /MAYBESITTER_FEATURE_CONTEXT_ENRICHMENT=false/);
  assert.match(staging, /MAYBESITTER_KILL_SWITCH_CONTEXT_ENRICHMENT=false/);
  assert.match(production, /MAYBESITTER_FEATURE_CONTEXT_ENRICHMENT=false/);
  assert.match(production, /MAYBESITTER_KILL_SWITCH_CONTEXT_ENRICHMENT=true/);
});
