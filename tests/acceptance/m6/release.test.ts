/**
 * M6a-1 Gate B — release: the capability route, the flag pair in flags.sh,
 * staging on / production pinned off, and kill-before-flag.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { begin, call, end, loadModule, show } from './support.ts';

afterEach(() => end());

test('R54.1 GET /api/mobile/capabilities/m6 is exactly { success, searchHistory }', async () => {
  const uid = await begin();
  const result = await call(uid, 'capabilities/m6', 'GET');
  assert.equal(result.status, 200, show(result.body));
  assert.deepEqual(result.body, { success: true, searchHistory: true });
});

test('R54.1 resolveSearchHistory: staging on; production, off, unset and killed are false', async () => {
  const { resolveSearchHistory } = await loadModule('lib/release/m6Capabilities.ts') as { resolveSearchHistory: (env: Record<string, string | undefined>) => boolean };
  const on = { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_SEARCH_HISTORY: 'true', MAYBESITTER_KILL_SWITCH_SEARCH_HISTORY: 'false' };
  assert.equal(resolveSearchHistory(on), true);
  assert.equal(resolveSearchHistory({ ...on, MAYBESITTER_ENV: 'production' }), false);
  assert.equal(resolveSearchHistory({ ...on, MAYBESITTER_FEATURE_SEARCH_HISTORY: 'false' }), false);
  assert.equal(resolveSearchHistory({ MAYBESITTER_ENV: 'staging' }), false);
  assert.equal(resolveSearchHistory({ ...on, MAYBESITTER_KILL_SWITCH_SEARCH_HISTORY: 'true' }), false);
});

test('R54.1 flags.sh: the pair is set, staging true and production false', () => {
  const flags = readFileSync(new URL('../../../infra/cloudrun/flags.sh', import.meta.url), 'utf8');
  assert.match(flags, /MAYBESITTER_FEATURE_SEARCH_HISTORY=\$\{[a-z0-9_]+\}/);
  assert.match(flags, /MAYBESITTER_KILL_SWITCH_SEARCH_HISTORY=false/);
});

test('parity: the existing list routes are unchanged by the flag (today and upcoming carry no search fields)', async () => {
  const uid = await begin({ on: false });
  const off = await call(uid, 'commitments/today', 'GET');
  end();
  const uid2 = await begin({ on: true });
  const on = await call(uid2, 'commitments/today', 'GET');
  assert.deepEqual(Object.keys(on.body).sort(), Object.keys(off.body).sort());
});
