/**
 * M5b-2b-2 Gate B, R1/R2 Server: off and killed (no re-add read or write,
 * today's outcome pass unchanged, the inbox and the model request
 * byte-identical for accounts that hold markers, every review of a marker
 * 404, suggestions citing a marker hidden and refused once the flag is off,
 * prior decisions filtered).
 * PLAN-M5b-2b-2 R1 "Off or killed", R2 "Off or killed", "Model context: Off",
 * REV-002, R2-001. See support.ts for the harness and the gate rules.
 *
 * The digest guard: the complete off-mode model request (system, context,
 * schema, limits) for a fixed account, with every id normalised by first
 * appearance (the outcome's id derives from a random event uuid; every
 * observation sits at a distinct instant, so the order is fixed by content).
 * PINNED_OFF_REQUEST was computed on the base and must never change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeFromObservations, suggestionPath } from '../../../lib/intelligence/proposalEngine.ts';
import { listObservations, observationPath, putObservations } from '../../../lib/intelligence/observationStore.ts';
import {
  CLAIM_KINDS, DAY_MS, NOW, assertAllClaimsRefused, assertHidden, begin, currentStorage, daysAgo, dropAt, droppedThenReadded,
  end, eventsCol, generateH, ids, inboxH, model, normaliseIds, reviewH, scan, seedMarker, seedSuggestion,
  setM5bSwitches, sha256, show, spyStorage, withStorage, writeRun, type ClaimKind,
} from './support.ts';

test.afterEach(() => end());

const PINNED_OFF_REQUEST = 'fa6a7f2b6308da930f1c1051cbe669e3e7cfcdd1a697396d9ebb284985c71000';

const SWITCHES = { off: { on: false }, killed: { killed: true } } as const;
type Name = keyof typeof SWITCHES;
const NAMES: readonly Name[] = ['off', 'killed'];

/** A fixed account: two statements at distinct instants, a learned drop, its re-confirm, one accepted legacy decision. */
async function fixedAccount(uid: string) {
  const [study] = await putObservations(uid, 'manual', 'digest-ref-study', daysAgo(3), [{ kind: 'intention', evidence: 'I want to plan my study week', confidence: 0.8 } as any], currentStorage() as any);
  await putObservations(uid, 'manual', 'digest-ref-evenings', daysAgo(1), [{ kind: 'constraint', evidence: 'My evenings are busy with family', confidence: 0.8 } as any], currentStorage() as any);
  const readd = await droppedThenReadded(uid, 'Call the dentist');
  await seedSuggestion(uid, 'action', [study!.id], {}, { title: 'Accepted legacy action', status: 'accepted', decidedAt: daysAgo(1), linkedEntityId: 'int_accepted_legacy' });
  return readd;
}

async function offRequestDigest(uid: string): Promise<string> {
  model.reset();
  model.answer(() => ({ suggestions: [] }));
  await proposeFromObservations(uid, NOW(), { storage: currentStorage() as any });
  assert.equal(model.calls.length, 1, `expected one model call, saw ${model.calls.length}`);
  return sha256(normaliseIds(model.calls[0]!.raw));
}

/* ── the scan ───────────────────────────────────────────────────────── */

for (const name of NAMES) {
  test(`R1 ${name} parity: the scan makes no re-add read and no write; today's outcome pass writes exactly today's row`, async () => {
    const uid = await begin();
    await droppedThenReadded(uid, 'Call the dentist');
    const d = await dropAt(uid, 'Water the plants', daysAgo(1));
    setM5bSwitches(SWITCHES[name]);
    const reads: string[] = [];
    const writes: string[] = [];
    const proxy = spyStorage(currentStorage(), {
      onRead: (method, path, options) => {
        if ((method.endsWith('get') || method.endsWith('getMany')) && JSON.stringify(path).includes(`${eventsCol(uid)}/`)) reads.push(`${method} ${JSON.stringify(path)}`);
        const clause = (options?.where ?? []).find((where: any[]) => where[0] === 'observedAt');
        if (method.endsWith('list') && clause && Date.parse(clause[2]) <= Date.now() - 30 * DAY_MS) reads.push(`${method} ${String(path)} ${JSON.stringify(options)}`);
      },
      onWrite: (method, path, value) => { writes.push(`${method} ${path} ${JSON.stringify(value)}`); },
    });
    await withStorage(proxy, () => scan(uid, proxy));
    assert.deepEqual(reads, [], `${name}: the scan made re-add reads`);
    const learned = (await listObservations(uid, currentStorage() as any)).filter((row) => row.evidence === 'Dropped: Water the plants');
    assert.equal(learned.length, 1, show(learned));
    const row = learned[0]!;
    assert.deepEqual(row, {
      kind: 'outcome', evidence: 'Dropped: Water the plants', confidence: 1, id: row.id, source: 'behavior',
      sourceRef: row.sourceRef, observedAt: daysAgo(1), review: 'confirmed', reviewedAt: daysAgo(1), linkedMemoryId: null,
    });
    assert.deepEqual(writes.map((line) => line.split(' ')[0]), ['tx.create'], `${name}: the scan wrote more than today's outcome row: ${show(writes)}`);
    assert.ok(writes[0]!.includes(observationPath(uid, row.id)));
    assert.ok(d);
  });
}

/* ── the inbox ──────────────────────────────────────────────────────── */

for (const name of NAMES) {
  test(`R2 ${name}: the inbox of an account holding a marker and a suggestion citing it is byte-identical to the same account without them`, async () => {
    const uid = await begin();
    const { c, outcome, confirmedAt } = await droppedThenReadded(uid, 'Call the dentist');
    const [plain] = await putObservations(uid, 'manual', 'inbox-ref-1', daysAgo(1), [{ kind: 'intention', evidence: 'I want to plan my study week', confidence: 0.8 } as any], currentStorage() as any);
    const clean = await seedSuggestion(uid, 'action', [plain!.id], {}, { title: 'Plan two study blocks' });
    const marker = await seedMarker(uid, c, outcome.id, confirmedAt);
    const citing = await seedSuggestion(uid, 'action', [marker.id], {}, { title: 'Keep the dentist routine going' });
    setM5bSwitches(SWITCHES[name]);
    const holding = await inboxH(uid);
    assert.ok(ids(holding.suggestions).includes(clean.id), 'fixture: the clean suggestion is not shown');
    await currentStorage().delete(observationPath(uid, marker.id));
    await currentStorage().delete(suggestionPath(uid, citing.id));
    const without = await inboxH(uid);
    assert.deepEqual(holding, without, `${name}: the inbox differs for an account holding a marker`);
  });
}

/* ── reviews ────────────────────────────────────────────────────────── */

for (const name of NAMES) {
  test(`R2 ${name}: any review of a readd: marker answers 404 not_found and leaves it unchanged`, async () => {
    const uid = await begin();
    const { c, outcome, confirmedAt } = await droppedThenReadded(uid, 'Call the dentist');
    const marker = await seedMarker(uid, c, outcome.id, confirmedAt);
    setM5bSwitches(SWITCHES[name]);
    for (const review of ['confirmed', 'dismissed'] as const) {
      const result = await reviewH(uid, marker.id, review);
      assert.equal(result.status, 404, `${name}: ${review} answered ${result.status} ${show(result.body)}`);
      assert.equal(result.body?.reason, 'not_found', show(result.body));
    }
    assert.deepEqual(await currentStorage().get(observationPath(uid, marker.id)), marker, `${name}: a review changed the marker`);
  });

  test(`R2 ${name} parity: reviews of other observations answer exactly as today`, async () => {
    const uid = await begin();
    const [pending] = await putObservations(uid, 'manual', 'review-ref-1', daysAgo(1), [{ kind: 'intention', evidence: 'I want to swim more', confidence: 0.8 } as any], currentStorage() as any);
    setM5bSwitches(SWITCHES[name]);
    const result = await reviewH(uid, pending!.id, 'confirmed');
    assert.equal(result.status, 200, show(result.body));
    assert.deepEqual(result.body, { success: true, observation: { ...pending, review: 'confirmed', reviewedAt: NOW() } });
  });
}

/* ── suggestions citing a marker once the flag is off (REV-002) ─────── */

for (const name of NAMES) {
  test(`REV-002 ${name}: after the flag goes ${name}, suggestions citing a marker are hidden from the inbox, generate reuse and schedules, and refused on all four claim paths`, async () => {
    const uid = await begin();
    const { c, outcome, confirmedAt } = await droppedThenReadded(uid, 'Call the dentist');
    const marker = await seedMarker(uid, c, outcome.id, confirmedAt);
    const [plain] = await putObservations(uid, 'manual', 'rev002-ref-1', daysAgo(1), [{ kind: 'intention', evidence: 'I want to plan my study week', confidence: 0.8 } as any], currentStorage() as any);
    const rows = {} as Record<ClaimKind, any>;
    for (const kind of CLAIM_KINDS) {
      rows[kind] = await seedSuggestion(uid, kind, [marker.id], {},
        { title: kind === 'question' ? 'Question: does the dentist still matter to you?' : `Keep the dentist going as ${kind}` });
    }
    const clean = await seedSuggestion(uid, 'action', [plain!.id], {}, { title: 'Plan two study blocks' });
    await writeRun(uid, {
      digest: 'seeded', contentDigest: 'seeded', claimId: 'seeded-claim', status: 'complete',
      generatedAt: NOW(), reservedUntil: NOW(), suggestionIds: [...CLAIM_KINDS.map((kind) => rows[kind].id), clean.id],
      visitDay: NOW().slice(0, 10), visitRuns: 1,
    });
    setM5bSwitches(SWITCHES[name]);
    const body = await inboxH(uid);
    assert.ok(ids(body.suggestions).includes(clean.id), 'control: the clean suggestion is not shown');
    assertHidden(body, rows, `${name} inbox`);
    const visit = await generateH(uid, { visit: true });
    assert.ok(ids(visit.suggestions).includes(clean.id), 'control: the visit did not reuse the run');
    assertHidden(visit, rows, `${name} generate (visit reuse)`);
    await assertAllClaimsRefused(uid, rows, true, name);
  });
}

/* ── the model request (R2 Off, R2-001) ─────────────────────────────── */

for (const name of NAMES) {
  test(`R2 ${name} parity: the off-mode model request is byte-identical to today's (pinned digest)`, async () => {
    const uid = await begin();
    await fixedAccount(uid);
    setM5bSwitches(SWITCHES[name]);
    assert.equal(await offRequestDigest(uid), PINNED_OFF_REQUEST);
  });

  test(`R2/R2-001 ${name}: an account holding a marker and a dismissed re-add-backed decision sends the same pinned request (markers and their decisions left out)`, async () => {
    const uid = await begin();
    const { c, outcome, confirmedAt } = await fixedAccount(uid);
    const marker = await seedMarker(uid, c, outcome.id, confirmedAt);
    const title = 'Keep the dentist routine going thanks to the re-add';
    await seedSuggestion(uid, 'action', [marker.id], {}, { title, status: 'dismissed', decidedAt: daysAgo(1) });
    setM5bSwitches(SWITCHES[name]);
    const digest = await offRequestDigest(uid);
    const raw = model.calls[0]!.raw;
    assert.equal(raw.includes(title), false, `${name}: a dismissed re-add-backed decision reached the model`);
    assert.equal(raw.includes(marker.id) || raw.includes('Re-added'), false, `${name}: a marker reached the model`);
    assert.equal(digest, PINNED_OFF_REQUEST, `${name}: the request differs from today's`);
  });
}

