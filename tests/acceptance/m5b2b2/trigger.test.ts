/**
 * M5b-2b-2 Gate B, R1 Server: the trigger (the confirm routes start the scan
 * after a successful confirm, so the marker exists when the route answers;
 * any other confirming path is caught on the next inbox read).
 * PLAN-M5b-2b-2 R1 "Trigger". See support.ts for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readParticipantState } from '../../../lib/services/mobile/participantState.ts';
import {
  NOW, begin, callWith, confirmAt, daysAgo, dropAt, end, inboxH, learn, markerFor, markers, plusMinutes, show,
} from './support.ts';

test.afterEach(() => end());

test('R1 trigger: POST /capture/confirm starts the scan: the marker exists when the route answers', async () => {
  const uid = await begin();
  await dropAt(uid, 'Call the bank', daysAgo(2));
  await learn(uid);
  const captured = await callWith(uid, 'capture', 'POST', { body: { text: 'Call the bank tomorrow at 5pm', referenceTime: NOW(), timezone: 'Asia/Jerusalem' } });
  assert.equal(captured.status, 200, show(captured.body));
  const item = captured.body.items?.[0];
  assert.equal(item?.title, 'Call the bank', `fixture: the capture proposed ${show(captured.body.items)}`);
  assert.deepEqual(await markers(uid), [], 'fixture: a marker exists before the confirm');
  const confirmed = await callWith(uid, 'capture/confirm', 'POST', { body: { proposalId: captured.body.proposalId, itemIds: [item.itemId] } });
  assert.equal(confirmed.status, 200, show(confirmed.body));
  const c = confirmed.body.persisted?.[0]?.commitmentId;
  assert.equal(typeof c, 'string', show(confirmed.body));
  await markerFor(uid, c, 'the confirm route did not start the re-add scan');
});

test('R1 trigger: POST /seeds/[id]/promote starts the scan: the marker exists when the route answers', async () => {
  const uid = await begin();
  const title = 'apply to NVIDIA this semester.';
  await dropAt(uid, title, daysAgo(2));
  await learn(uid);
  const proposed = await callWith(uid, 'capture', 'POST', { body: { text: "Maybe I'll apply to NVIDIA this semester.", referenceTime: NOW(), timezone: 'UTC' } });
  assert.equal(proposed.status, 200, show(proposed.body));
  const kept = await callWith(uid, 'seeds', 'POST', { body: { proposalId: proposed.body.proposalId, seedItemId: proposed.body.seeds?.[0]?.seedItemId } });
  assert.equal(kept.status, 201, show(kept.body));
  const promoted = await callWith(uid, 'seeds/[id]/promote', 'POST', { params: { id: kept.body.seed.seedId }, body: { target: 'commitment' } });
  assert.equal(promoted.status, 200, show(promoted.body));
  const c = promoted.body.seed?.promotedTo?.id;
  assert.equal((await readParticipantState(uid)).commitments[c]?.title, title, 'fixture: the promoted commitment has another title');
  await markerFor(uid, c, 'the promote route did not start the re-add scan');
});

test('R1 trigger: a commitment confirmed by any other path is caught on the next inbox read', async () => {
  const uid = await begin();
  await dropAt(uid, 'Renew the passport', daysAgo(2));
  await learn(uid);
  const c = await confirmAt(uid, 'Renew the passport', plusMinutes(NOW(), -5));
  await inboxH(uid);
  await markerFor(uid, c, 'the inbox read did not catch the re-add');
});
