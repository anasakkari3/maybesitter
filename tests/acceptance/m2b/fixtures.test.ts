/**
 * M2b Task B, criterion 4 (Fixtures): the exporter
 * (`tests/mobile/exportMobileApiFixtures.test.ts`) writes five new capture
 * cases from the real route — `capture.chatEditKind` (consideration→commitment
 * and commitment→idea), `capture.chatEditTime` (a ranged move),
 * `capture.chatEditWords`, `capture.chatCorrection` (spoken, one correction)
 * and `capture.chatEditStale` (the 409) — which the mobile suite validates
 * against its schemas. Held here on the committed files.
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on d93a9a2b for the reason its criterion names (the files do not exist).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertUnderstoodValid, show, type Answer } from './support.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'mobile', 'src', 'api', '__fixtures__');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fixture(name: string): any {
  const path = join(FIXTURES, `${name}.json`);
  assert.ok(existsSync(path), `the exporter wrote no ${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** An edit's answer: a chat answer whose proposal is past revision 0, with valid understood points and a recorded turn pair. */
function assertEditAnswer(body: Answer, name: string): void {
  assert.equal(typeof body.conversationId, 'string', `${name}: not a chat answer`);
  assert.ok(body.proposal, `${name}: no proposal`);
  assert.ok(Number.isInteger(body.proposal!.revision) && body.proposal!.revision! >= 1, `${name}: the proposal is not past revision 0 (${show(body.proposal!.revision)})`);
  assertUnderstoodValid(body.proposal, name);
  assert.ok(Array.isArray(body.turns) && body.turns.length >= 4, `${name}: the message and the edit are not both in the turns`);
  assert.deepEqual(body.turns.slice(-2).map((turn) => turn.role), ['user', 'assistant'], `${name}: the edit's turn pair is not last`);
}

test('B4 fixtures: capture.chatEditKind — an edited answer holding both a commitment and an idea seed', () => {
  const body = fixture('capture.chatEditKind') as Answer;
  assertEditAnswer(body, 'capture.chatEditKind');
  assert.ok(body.proposal!.items.length >= 1, 'no commitment item (consideration→commitment)');
  assert.ok(body.proposal!.seeds.some((seed) => seed.kind === 'idea'), 'no idea seed (commitment→idea)');
});

test('B4 fixtures: capture.chatEditTime — a moved ranged item, endTime after resolvedTime', () => {
  const body = fixture('capture.chatEditTime') as Answer;
  assertEditAnswer(body, 'capture.chatEditTime');
  const ranged = body.proposal!.items.filter((item) => typeof item.endTime === 'string');
  assert.equal(ranged.length, 1, 'not one ranged item');
  assert.ok(ranged[0]!.resolvedTime && Date.parse(ranged[0]!.endTime!) > Date.parse(ranged[0]!.resolvedTime), 'the end is not after the start');
});

test('B4 fixtures: capture.chatEditWords — an edited answer', () => {
  const body = fixture('capture.chatEditWords') as Answer;
  assertEditAnswer(body, 'capture.chatEditWords');
});

test('B4 fixtures: capture.chatCorrection — one item with exactly one well-formed correction applied in its title', () => {
  const body = fixture('capture.chatCorrection') as Answer;
  assert.ok(body.proposal, 'no proposal');
  const corrected = body.proposal!.items.filter((item) => Array.isArray(item.corrections) && item.corrections.length > 0);
  assert.equal(corrected.length, 1, 'not one item with corrections');
  const corrections = corrected[0]!.corrections!;
  assert.equal(corrections.length, 1, 'not exactly one correction');
  const [correction] = corrections;
  assert.equal(typeof correction!.id, 'string');
  assert.ok(correction!.id.length > 0, 'an empty correction id');
  assert.ok(/^\S+$/.test(correction!.from) && /^\S+$/.test(correction!.to), `not one word each side: ${show(correction)}`);
  const words = corrected[0]!.title.split(/\s+/);
  assert.ok(words.includes(correction!.to), `the corrected word «${correction!.to}» is not in the title «${corrected[0]!.title}»`);
});

test('B4 fixtures: capture.chatEditStale — the 409 { reason: proposal_changed, answer } carrying a current answer with its revision', () => {
  const body = fixture('capture.chatEditStale');
  assert.equal(body.reason, 'proposal_changed');
  assert.ok(body.answer && typeof body.answer.conversationId === 'string', 'the 409 carries no chat answer');
  assert.ok(body.answer.proposal && Number.isInteger(body.answer.proposal.revision), 'the current answer\'s proposal carries no revision');
});
