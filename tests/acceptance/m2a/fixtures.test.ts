/**
 * M2a Task B, criterion 5 (Fixtures): the exporter
 * (`tests/mobile/exportMobileApiFixtures.test.ts`) writes four new capture
 * cases from the real route — `capture.chatUnderstoodMany` (five points,
 * interleaved kinds), `capture.chatConsideration`, `capture.chatGoalStatement`
 * and `capture.chatRange` — which the mobile suite validates against its
 * schemas. Held here on the committed files.
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on 0620a7b2 for the reason its criterion names (the files do not exist).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertUnderstoodValid, type ChatBody } from './support.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'mobile', 'src', 'api', '__fixtures__');

function fixture(name: string): ChatBody {
  const path = join(FIXTURES, `${name}.json`);
  assert.ok(existsSync(path), `the exporter wrote no ${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as ChatBody;
}

test('B5 fixtures: capture.chatUnderstoodMany — five understood points with interleaved kinds', () => {
  const body = fixture('capture.chatUnderstoodMany');
  const points = assertUnderstoodValid(body.proposal, 'capture.chatUnderstoodMany');
  assert.equal(points.length, 5, 'not five points');
  const isCommitment = points.map((point) => point.kind === 'commitment');
  assert.ok(isCommitment.includes(true) && isCommitment.includes(false), 'not both commitments and seeds');
  const runs = isCommitment.filter((value, index) => index === 0 || value !== isCommitment[index - 1]).length;
  assert.ok(runs >= 3, `the kinds are grouped, not interleaved: ${points.map((point) => point.kind).join(', ')}`);
});

test('B5 fixtures: capture.chatConsideration — a consideration seed, no item', () => {
  const body = fixture('capture.chatConsideration');
  assert.ok(body.proposal, 'no proposal');
  assert.equal(body.proposal!.items.length, 0, 'a consideration became an item');
  assert.deepEqual(body.proposal!.seeds.map((seed) => seed.kind), ['consideration']);
  assertUnderstoodValid(body.proposal, 'capture.chatConsideration');
});

test('B5 fixtures: capture.chatGoalStatement — a possible_goal seed, no item, no «إيمتى بدك…»', () => {
  const body = fixture('capture.chatGoalStatement');
  assert.ok(body.proposal, 'no proposal');
  assert.equal(body.proposal!.items.length, 0, 'a goal statement became an item');
  assert.deepEqual(body.proposal!.seeds.map((seed) => seed.kind), ['possible_goal']);
  assert.ok(!body.reply.includes('إيمتى بدك'), `the goal fixture asks for a time: ${body.reply}`);
  assertUnderstoodValid(body.proposal, 'capture.chatGoalStatement');
});

test('B5 fixtures: capture.chatRange — an item with an endTime after its resolvedTime', () => {
  const body = fixture('capture.chatRange');
  assert.ok(body.proposal, 'no proposal');
  const ranged = body.proposal!.items.filter((item) => typeof item.endTime === 'string');
  assert.equal(ranged.length, 1, 'no item carries an endTime');
  const item = ranged[0]!;
  assert.ok(item.resolvedTime, 'the ranged item has no start');
  assert.ok(Date.parse(item.endTime!) > Date.parse(item.resolvedTime!), 'the end is not after the start');
});
