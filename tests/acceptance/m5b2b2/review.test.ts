/**
 * M5b-2b-2 Gate B, R2 Server: review and suggestions (confirm and dismiss a
 * marker on the existing path; a suggestion citing a dismissed marker, or a
 * marker whose bound outcome was dismissed, hidden from every read and
 * refused on all four claim paths; the client capability header; prior
 * decisions without the header).
 * PLAN-M5b-2b-2 R2 "Review needs no new server path", owner decision 4,
 * REV-004, REV-005, R2-001. See support.ts for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_KINDS, NOW, assertAllClaimsRefused, assertHidden, begin, droppedThenReadded, end, generateH, ids, inboxH, inboxRow,
  isMarker, markerFor, model, objects, reviewH, scan, seedMarker, seedSuggestion, show, statement, writeRun, type ClaimKind,
} from './support.ts';

test.afterEach(() => end());

const KINDS = CLAIM_KINDS;
type Kind = ClaimKind;

/** A pending on_basis suggestion of every kind citing `observationId`, a clean one, and a recent run listing them all (so a visit reuses it). */
async function citing(uid: string, observationId: string, tag: string) {
  const evidence = await statement(uid, `I want to sort out my week ${tag}`);
  const rows = {} as Record<Kind, any>;
  for (const kind of KINDS) {
    rows[kind] = await seedSuggestion(uid, kind, [observationId], { mode: 'on_basis' },
      { title: kind === 'question' ? `Question ${tag}: does this still matter to you?` : `Keep going with it ${tag} as ${kind}` });
  }
  const clean = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis' }, { title: `Plan two calm blocks ${tag}` });
  await writeRun(uid, {
    digest: 'seeded', contentDigest: 'seeded', claimId: 'seeded-claim', status: 'complete', mode: 'on_basis',
    generatedAt: NOW(), reservedUntil: NOW(), suggestionIds: [...KINDS.map((kind) => rows[kind].id), clean.id],
    visitDay: NOW().slice(0, 10), visitRuns: 1,
  });
  return { rows, clean, evidence };
}

/* ── review on the existing path ────────────────────────────────────── */

test('R2 review: «آه، هيك صح» confirms a pending marker and it stays at 0.6 (owner decision 3); «مش صحيح» then dismisses it', async () => {
  const uid = await begin();
  const { c } = await droppedThenReadded(uid, 'Call the dentist');
  await scan(uid);
  const marker = await markerFor(uid, c);
  const confirmed = await reviewH(uid, marker.id, 'confirmed');
  assert.equal(confirmed.status, 200, show(confirmed.body));
  assert.equal(confirmed.body.observation.review, 'confirmed');
  assert.equal(confirmed.body.observation.confidence, 0.6);
  assert.equal((await markerFor(uid, c)).confidence, 0.6, 'a confirmed re-add changed confidence');
  assert.deepEqual(inboxRow(await inboxH(uid), marker.id)?.readd, { after: 'dropped', title: 'Call the dentist' }, 'a confirmed re-add lost its field');
  const dismissed = await reviewH(uid, marker.id, 'dismissed');
  assert.equal(dismissed.status, 200, show(dismissed.body));
  assert.equal(dismissed.body.observation.review, 'dismissed');
});

test('R2 review: «مش صحيح» dismisses a pending marker directly', async () => {
  const uid = await begin();
  const { c } = await droppedThenReadded(uid, 'Water the plants', { verb: 'completed' });
  await scan(uid);
  const marker = await markerFor(uid, c);
  const result = await reviewH(uid, marker.id, 'dismissed');
  assert.equal(result.status, 200, show(result.body));
  assert.equal(result.body.observation.review, 'dismissed');
  assert.equal((await markerFor(uid, c)).review, 'dismissed');
});

/* ── suggestions citing a re-add ────────────────────────────────────── */

test('R2 review: a suggestion citing a dismissed marker is hidden from the inbox, generate and schedules, and refused on all four claim paths', async () => {
  const uid = await begin();
  const { c } = await droppedThenReadded(uid, 'Clean the garage');
  await scan(uid);
  const marker = await markerFor(uid, c);
  const { rows, clean } = await citing(uid, marker.id, 'one');
  assert.equal((await reviewH(uid, marker.id, 'dismissed')).status, 200);
  const body = await inboxH(uid);
  assert.ok(ids(body.suggestions).includes(clean.id), 'control: the clean suggestion is not shown');
  assertHidden(body, rows, 'inbox');
  assertHidden(await generateH(uid, { visit: true }), rows, 'generate (visit reuse)');
  assertHidden(await generateH(uid), rows, 'generate');
  await assertAllClaimsRefused(uid, rows, true, 'dismissed marker');
});

test('Owner decision 4/REV-004: «مش صحيح» on the earlier outcome hides every suggestion citing the re-add at once: gone from the inbox and generate, and accepting creates nothing', async () => {
  const uid = await begin();
  const { c, outcome } = await droppedThenReadded(uid, 'Clean the garage');
  await scan(uid);
  const marker = await markerFor(uid, c);
  const { rows, clean } = await citing(uid, marker.id, 'two');
  const before = await inboxH(uid);
  for (const kind of KINDS) assert.ok(ids(before.suggestions).includes(rows[kind].id), `control: the ${kind} citing a live re-add is not shown`);
  assert.equal((await reviewH(uid, outcome.id, 'dismissed')).status, 200, 'fixture: the earlier outcome could not be dismissed');
  const body = await inboxH(uid);
  assert.ok(ids(body.suggestions).includes(clean.id), 'control: the clean suggestion is not shown');
  assertHidden(body, rows, 'inbox');
  assert.equal(inboxRow(body, marker.id), undefined, 'the marker is still shown after its outcome was dismissed');
  assertHidden(await generateH(uid, { visit: true }), rows, 'generate (visit reuse)');
  assertHidden(await generateH(uid), rows, 'generate');
  await assertAllClaimsRefused(uid, rows, true, 'outcome dismissed');
});

/* ── the client header (REV-005) ────────────────────────────────────── */

test('REV-005: without X-MaybeSitter-Client-Features: readd the server omits markers and re-add-backed suggestions from the inbox and generate, and refuses them in every claim', async () => {
  const uid = await begin();
  const { c } = await droppedThenReadded(uid, 'Call the dentist');
  await scan(uid);
  const marker = await markerFor(uid, c);
  const { rows, clean } = await citing(uid, marker.id, 'three');
  const withHeader = await inboxH(uid, true);
  assert.ok(inboxRow(withHeader, marker.id)?.readd, 'control: with the header the marker is not shown');
  const old = await inboxH(uid, false);
  assert.equal((old.observations ?? []).some((row: any) => isMarker(row)), false, `an old client was sent a marker: ${show(old.observations)}`);
  assert.equal(objects(old).some((row) => 'readd' in row), false, 'an old client was sent a readd field');
  assert.ok(ids(old.suggestions).includes(clean.id), 'control: the clean suggestion is not shown to an old client');
  assertHidden(old, rows, 'inbox without the header');
  assertHidden(await generateH(uid, { visit: true, header: false }), rows, 'generate (visit reuse) without the header');
  assertHidden(await generateH(uid, { header: false }), rows, 'generate without the header');
  await assertAllClaimsRefused(uid, rows, false, 'no header');
});

test('R2-001: without the header, a dismissed re-add-backed suggestion\'s title and decision never reach the model', async () => {
  const uid = await begin();
  const { c, outcome, confirmedAt } = await droppedThenReadded(uid, 'Call the dentist');
  const marker = await seedMarker(uid, c, outcome.id, confirmedAt);
  const title = 'Keep the dentist routine going thanks to the re-add';
  await seedSuggestion(uid, 'action', [marker.id], { mode: 'on_basis' }, { title, status: 'dismissed', decidedAt: NOW() });
  await generateH(uid, { header: false });
  assert.ok(model.calls.length >= 1, 'the model was never called');
  for (const call of model.calls) {
    assert.equal(call.raw.includes(title), false, 'the re-add-backed decision reached the model without the header');
    assert.equal((call.context?.priorDecisions ?? []).some((row: any) => row.title === title), false);
  }
});
