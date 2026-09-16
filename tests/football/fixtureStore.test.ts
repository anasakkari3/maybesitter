// tests/football/fixtureStore.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { fixtureDoc } from '../../lib/storage/paths.ts';
import { upsertFixtures, listFixturesForTeam } from '../../lib/football/fixtureStore.ts';
import { fixtureContentHash, FIXTURE_CONTRACT_VERSION, FIXTURE_SCHEMA_VERSION } from '../../src/contracts/v1/fixtureContracts.ts';

function fixture(id: string, kickoffUtc: string, over: Partial<Record<string, unknown>> = {}) {
  const core = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc, status: 'scheduled', venue: null,
    ...over,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core as never) };
}

test.beforeEach(() => setStorageForTests(createMemoryStorage()));
test.afterEach(() => resetStorageForTests());

test('a fixture is stored once per provider match id', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  const found = await listFixturesForTeam('81', { fromIso: '2026-10-01', toIso: '2026-11-01' });
  assert.equal(found.length, 1);
});

test('an unchanged fixture is not rewritten', async () => {
  // Rewriting every fixture nightly would make every commitment look changed,
  // and the projection would reschedule reminders nobody asked to move.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  const second = await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  assert.deepEqual(second, { written: 0, unchanged: 1 });
});

test('a moved kickoff is written', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  const second = await upsertFixtures([fixture('1', '2026-10-26T19:00:00.000Z')]);
  assert.deepEqual(second, { written: 1, unchanged: 0 });
});

test('a team listing includes away matches', async () => {
  await upsertFixtures([fixture('2', '2026-10-25T19:00:00.000Z', { homeTeamId: '86', awayTeamId: '81' })]);
  const found = await listFixturesForTeam('81', { fromIso: '2026-10-01', toIso: '2026-11-01' });
  assert.equal(found.length, 1, 'a club plays half its matches away from home');
});

test('fixtures live outside the user tree', () => {
  assert.ok(!fixtureDoc('football-data', '1').startsWith('users/'));
});

test('firestore rules deny clients the fixture collection', () => {
  // The catch-all denies everything not under /users/{uid}. This test exists so
  // that a future rules edit that opens a new top-level path has to look here.
  const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
  assert.ok(/match \/\{any=\*\*\} \{\s*allow read, write: if false;/.test(rules));
  assert.ok(!/match \/fixtures/.test(rules));
});
