/**
 * M5b-2b-1 Gate B, R1/R2 Server: the export (no `memoryBasis`, no
 * `memoryCitations`, residue cleanup verified or 503, the leased
 * `account_export` reservation, no lease field in the archive, the
 * account-deletion fence on the lease).
 * PLAN-M5b-2b-1 R2 ("Never exposed") + R8-003, R9-002, R9-004, R10-003,
 * R11-001, R13-002, R14-001. See support.ts for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCanonicalObservations } from '../../../lib/intelligence/canonicalObservations.ts';
import { USER_SCOPED_COLLECTIONS } from '../../../lib/storage/paths.ts';
import { EXPORT_EXCLUDED_COLLECTIONS, MAX_EXPORTS_PER_DAY } from '../../../lib/account/accountExport.ts';
import {
  NOW, addFloating, addRows, begin, citationPath, currentStorage, end, epochOf, exportAccount, markDeletedNow,
  memoryObservations, memoryUnreadable, revokeMemory, seedSuggestion, show, spyStorage, statement, stored,
  sweepAccountNow, userPaths, withStorage, writeCitation,
} from './support.ts';

test.afterEach(() => end());

const MORNING = 'I work best in the morning';
const SWIM = 'Learn to swim this summer';
const DAY = () => NOW().slice(0, 10);

function leasePaths(uid: string): string[] {
  return ((currentStorage() as any).pathsForTests() as string[]).filter((path) => path.startsWith(`users/${uid}/exportLeases/`));
}

function exportCountPaths(uid: string): string[] {
  return ((currentStorage() as any).pathsForTests() as string[]).filter((path) => path.startsWith(`users/${uid}/usage/account_export`));
}

/** A residue row: a basis-bearing suggestion whose memory is no longer eligible, and a copy of an inactive memory. */
async function residueFixture() {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: SWIM, kind: 'goal' }]);
  const a = rows.find((row) => row.content === MORNING);
  const goal = rows.find((row) => row.content === SWIM);
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const copy = (await memoryObservations(uid)).find((row) => row.sourceRef === goal!.id)!;
  assert.ok(copy, 'fixture: no observation copy of the goal');
  const commitment = await addFloating(uid, 'Call the bank');
  const evidence = await statement(uid, 'I want to plan my study week');
  const residue = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch: await epochOf(uid) });
  await revokeMemory(a!.id);
  await revokeMemory(goal!.id);
  return { uid, residue, copy, commitment };
}

/* ── never exposed (R2, R9-002, R13-002) ────────────────────────────── */

test('R2/R9-002: the export carries no memoryBasis on any suggestion and no memoryCitations collection, and says why the index is left out', async () => {
  const uid = await begin();
  const [a] = await addRows(uid, [{ content: MORNING }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const cited = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch: await epochOf(uid) });
  assert.ok(await currentStorage().get(citationPath(uid, a!.id, cited.id)), 'fixture: no citation row');
  const exported = await exportAccount(uid);
  assert.equal(exported.status, 200, show(exported.body));
  const proposals = exported.body.collections.intelligenceProposals;
  assert.ok(proposals.some((row: any) => row.id === cited.id), 'fixture: the eligible cited suggestion is not exported');
  for (const row of proposals) assert.equal('memoryBasis' in row.data, false, `the export carries memoryBasis: ${show(row.data)}`);
  assert.equal('memoryCitations' in exported.body.collections, false, 'the export carries the citation index');
  assert.equal(JSON.stringify(exported.body).includes(`${a!.id}__${cited.id}`), false, 'a citation row id reached the export');
  assert.equal(typeof exported.body.excluded.memoryCitations, 'string', 'the export does not say why memoryCitations is left out');
});

test('R9-002/R13-002: memoryCitations and exportLeases are user-scoped (deleted with the account) and excluded from the export with a reason', () => {
  for (const name of ['memoryCitations', 'exportLeases']) {
    assert.ok((USER_SCOPED_COLLECTIONS as readonly string[]).includes(name), `${name} is not in USER_SCOPED_COLLECTIONS`);
    const reason = EXPORT_EXCLUDED_COLLECTIONS[name];
    assert.equal(typeof reason, 'string', `${name} is not in EXPORT_EXCLUDED_COLLECTIONS`);
    assert.ok(reason!.trim().length > 20, `${name} has no documented reason`);
  }
});

/* ── residue cleanup, verified (R8-003, R9-004) ─────────────────────── */

test('R8-003: before building, the export removes every residue row (basis-bearing suggestions on ineligible memory, copies of inactive memory) and the archive carries none', async () => {
  const { uid, residue, copy, commitment } = await residueFixture();
  const exported = await exportAccount(uid);
  assert.equal(exported.status, 200, show(exported.body));
  assert.equal(exported.body.collections.intelligenceProposals.some((row: any) => row.id === residue.id), false, 'the archive carries a residue suggestion');
  assert.equal(exported.body.collections.intelligenceObservations.some((row: any) => row.id === copy.id), false, 'the archive carries a copy of an inactive memory');
  assert.equal(await stored(uid, residue.id), null, 'the residue suggestion was not cleaned');
  assert.equal((await memoryObservations(uid)).some((row) => row.id === copy.id), false, 'the residue observation was not cleaned');
  assert.ok(exported.body.collections.commitments.some((row: any) => row.id === commitment), 'an unrelated record is missing from the archive');
});

test('R8-003: a cleanup fault leaves a residue row, so the export answers 503 (never a partial archive); the retry cleans it and the archive is complete', async () => {
  const { uid, residue, commitment } = await residueFixture();
  let faulted = false;
  const residuePath = `users/${uid}/intelligenceProposals/${residue.id}`;
  const spy = spyStorage(currentStorage(), {
    onWrite: (method, path) => {
      if (faulted || path !== residuePath || !(method === 'delete' || method === 'tx.delete')) return;
      faulted = true;
      throw new Error('fault injected in the residue cleanup');
    },
  });
  const first = await withStorage(spy, () => exportAccount(uid));
  assert.equal(first.status, 503, `expected a retryable 503, got ${first.status} ${show(first.body).slice(0, 300)}`);
  assert.equal(first.body?.collections, undefined, 'a partial archive was returned');
  const second = await exportAccount(uid);
  assert.equal(second.status, 200, show(second.body));
  assert.equal(second.body.collections.intelligenceProposals.some((row: any) => row.id === residue.id), false);
  assert.equal(await stored(uid, residue.id), null);
  assert.ok(second.body.collections.commitments.some((row: any) => row.id === commitment), 'the archive is incomplete');
  assert.ok(faulted, 'fixture: the cleanup never deleted the residue row');
});

test('R9-004: the export never degrades by row: an unreadable memory snapshot answers 503', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: MORNING }]);
  await addFloating(uid, 'Call the bank');
  const result = await withStorage(memoryUnreadable(currentStorage()), () => exportAccount(uid));
  assert.equal(result.status, 503, `expected 503, got ${result.status} ${show(result.body).slice(0, 300)}`);
  assert.equal(result.body?.collections, undefined, 'a partial archive was returned');
});

/* ── the leased daily reservation (R10-003, R11-001, R13-002) ───────── */

test('R10-003/R11-001: three retryable 503 failures consume no daily export: three exports then succeed, and the cap of 3 still holds', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: MORNING }]);
  for (let index = 0; index < 3; index += 1) {
    const failed = await withStorage(memoryUnreadable(currentStorage()), () => exportAccount(uid));
    assert.equal(failed.status, 503, `failure ${index + 1}: expected 503, got ${failed.status}`);
  }
  for (let index = 0; index < MAX_EXPORTS_PER_DAY; index += 1) {
    const ok = await exportAccount(uid);
    assert.equal(ok.status, 200, `export ${index + 1} after the failures: ${ok.status} ${show(ok.body).slice(0, 200)}`);
  }
  const capped = await exportAccount(uid);
  assert.equal(capped.status, 429, `the daily cap no longer holds: ${capped.status}`);
  assert.equal(capped.body.reason, 'export_rate_limited');
});

test('R11-001 parity: an account whose model calls reached their daily cap can still export (the model permit is not used)', async () => {
  const uid = await begin();
  await currentStorage().set(`users/${uid}/usage/${DAY()}`, { calls: 10_000, date: DAY(), updatedAt: NOW(), inputTokens: 1_000_000, outputTokens: 1_000_000 });
  const result = await exportAccount(uid);
  assert.equal(result.status, 200, show(result.body).slice(0, 300));
});

test('R11-001: the export holds a leased account_export reservation in exportLeases while it builds the archive', async () => {
  const uid = await begin();
  await addFloating(uid, 'Call the bank');
  const during: { leases: string[] | null } = { leases: null };
  const spy = spyStorage(currentStorage(), {
    onRead: (method, path) => {
      if (during.leases === null && method === 'list' && path === `users/${uid}/commitments`) during.leases = leasePaths(uid);
    },
  });
  const result = await withStorage(spy, () => exportAccount(uid));
  assert.equal(result.status, 200, show(result.body).slice(0, 300));
  assert.ok(during.leases !== null, 'fixture: the export never read the commitments');
  assert.ok(during.leases.length >= 1, 'no exportLeases reservation was held while the archive was built');
});

test('R13-002: an archive built while its own lease is held carries no lease field anywhere, and no exportLeases collection', async () => {
  const uid = await begin();
  await addFloating(uid, 'Call the bank');
  const result = await exportAccount(uid);
  assert.equal(result.status, 200, show(result.body).slice(0, 300));
  assert.equal('exportLeases' in result.body.collections, false, 'the archive carries exportLeases');
  const leaseKey = /lease|owner|reservation|reserved/i;
  for (const row of result.body.collections.usage ?? []) {
    for (const key of Object.keys(row.data)) assert.equal(leaseKey.test(key), false, `the archive's usage row ${row.id} carries a lease field ${key}`);
  }
  assert.equal(typeof result.body.excluded.exportLeases, 'string', 'the archive does not say why exportLeases is left out');
});

/* ── the account-deletion fence on the lease (R14-001) ──────────────── */

for (const [what, land] of [
  ['markDeleted', markDeletedNow],
  ['the user-tree sweep', sweepAccountNow],
] as const) {
  test(`R14-001: ${what} committing before the lease transaction leaves no lease or export count (nothing recreated) and no archive`, async () => {
    const uid = await begin();
    await addFloating(uid, 'Call the bank');
    let fired = false;
    const spy = spyStorage(currentStorage(), {
      onRead: async (method, path) => {
        if (fired || !method.startsWith('tx.') || typeof path !== 'string' || !/^users\/[^/]+\/(usage|exportLeases)\//.test(path)) return;
        fired = true;
        await land(uid);
      },
    });
    const result = await withStorage(spy, () => exportAccount(uid));
    assert.deepEqual(leasePaths(uid), [], 'a lease was written for a deleted account');
    assert.deepEqual(exportCountPaths(uid), [], 'an export count was committed for a deleted account');
    if (what === 'the user-tree sweep') assert.deepEqual(userPaths(uid), [], 'a user-scoped row was recreated behind the sweep');
    assert.notEqual(result.status, 200, 'an archive was returned for a deleted account');
    assert.ok(fired, 'fixture: the export never reserved');
  });
}
