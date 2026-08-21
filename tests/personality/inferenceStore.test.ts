/**
 * Provenance as a data invariant, not a prompt instruction.
 *
 * "An inference must never silently become a user fact" cannot be enforced by
 * asking a model nicely — a prompt is text and text gets injected. It is
 * enforced here, in the only function that can change a provenance, and these
 * tests pin every branch of that function including the ones that must do
 * nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVENANCE_VALUES,
  createEntry,
  promoteToFact,
  sendableToUser,
  type PersonalStateEntry,
  type Provenance,
} from '../../src/personality/inferenceStore.ts';

const now = new Date('2026-08-21T09:00:00.000Z');

function entryWith(provenance: Provenance, confidence = 0.8): PersonalStateEntry {
  return { id: 'x', key: 'k', value: 'v', provenance, confidence, createdAt: now.toISOString() };
}

test('anything a model produced starts as an INFERENCE', () => {
  const entry = createEntry({
    id: 'e1', key: 'peak_hour', value: '09', source: 'model', confidence: 0.8, now,
  });
  assert.equal(entry.provenance, 'INFERENCE');
});

test('something the user stated is a FACT', () => {
  const entry = createEntry({
    id: 'e2', key: 'quiet_hours', value: '23:00-07:00', source: 'user_explicit', confidence: 1, now,
  });
  assert.equal(entry.provenance, 'FACT');
});

test('an inference cannot become a fact without the user confirming', () => {
  const inference = createEntry({
    id: 'e3', key: 'peak_hour', value: '09', source: 'model', confidence: 0.95, now,
  });

  assert.equal(promoteToFact(inference, false).provenance, 'INFERENCE');
});

test('the user confirming is what promotes it', () => {
  const inference = createEntry({
    id: 'e4', key: 'peak_hour', value: '09', source: 'model', confidence: 0.6, now,
  });

  const promoted = promoteToFact(inference, true);
  assert.equal(promoted.provenance, 'FACT');
  assert.equal(promoted.confidence, 1);
});

test('high confidence alone never promotes — confidence is not consent', () => {
  const inference = createEntry({
    id: 'e5', key: 'peak_hour', value: '09', source: 'model', confidence: 0.99, now,
  });
  assert.equal(promoteToFact(inference, false).provenance, 'INFERENCE');
});

test('every entry shown to the user carries its provenance', () => {
  const entries = sendableToUser([
    createEntry({ id: 'e6', key: 'a', value: '1', source: 'model', confidence: 0.5, now }),
  ]);
  assert.equal(entries.every((e) => e.provenance !== undefined), true);
});

test('all six provenance classes exist and none is an alias of another', () => {
  assert.deepEqual([...PROVENANCE_VALUES].sort(), [
    'CONSTRAINT',
    'FACT',
    'GOAL',
    'INFERENCE',
    'OBSERVATION',
    'PREFERENCE',
  ]);
  assert.equal(new Set(PROVENANCE_VALUES).size, 6);
});

test('each of the six classes is reachable through createEntry', () => {
  const bySource: Array<[Parameters<typeof createEntry>[0]['source'], Provenance]> = [
    ['user_explicit', 'FACT'],
    ['user_preference', 'PREFERENCE'],
    ['user_goal', 'GOAL'],
    ['user_constraint', 'CONSTRAINT'],
    ['behaviour', 'OBSERVATION'],
    ['model', 'INFERENCE'],
  ];

  for (const [source, expected] of bySource) {
    const entry = createEntry({ id: source, key: 'k', value: 'v', source, confidence: 0.5, now });
    assert.equal(entry.provenance, expected, `${source} should record ${expected}`);
  }
});

test('a behavioural OBSERVATION the user confirms becomes a FACT', () => {
  // OBSERVATION and INFERENCE are the two provisional classes: both are the
  // system's own claim about the user, so the user confirming one is the same
  // epistemic move in both cases.
  const promoted = promoteToFact(entryWith('OBSERVATION'), true);
  assert.equal(promoted.provenance, 'FACT');
  assert.equal(promoted.confidence, 1);
});

test('a confirmed CONSTRAINT stays a CONSTRAINT', () => {
  // A constraint is not a weaker fact, it is a different kind of statement:
  // downstream scheduling dispatches on it. Confirming it must not flatten it.
  const confirmed = promoteToFact(entryWith('CONSTRAINT'), true);
  assert.equal(confirmed.provenance, 'CONSTRAINT');
});

test('confirming a PREFERENCE or a GOAL does not turn it into a FACT', () => {
  assert.equal(promoteToFact(entryWith('PREFERENCE'), true).provenance, 'PREFERENCE');
  assert.equal(promoteToFact(entryWith('GOAL'), true).provenance, 'GOAL');
});

test('confirming something already a FACT changes nothing', () => {
  const fact = entryWith('FACT', 1);
  assert.deepEqual(promoteToFact(fact, true), fact);
});

test('promotion returns a new entry rather than editing the stored one', () => {
  const inference = createEntry({
    id: 'e7', key: 'peak_hour', value: '09', source: 'model', confidence: 0.6, now,
  });
  promoteToFact(inference, true);

  assert.equal(inference.provenance, 'INFERENCE', 'the stored entry was mutated in place');
  assert.equal(inference.confidence, 0.6);
});

test('an entry with an unrecognised provenance is shown as an INFERENCE', () => {
  // Entries arrive from storage as JSON, where the union type is gone. An
  // origin we cannot verify is the weakest claim we have, never the strongest.
  const decoded = { ...entryWith('FACT'), provenance: 'VERIFIED' as unknown as Provenance };

  assert.equal(sendableToUser([decoded])[0].provenance, 'INFERENCE');
});

test('what the user is shown cannot be edited back into the store', () => {
  const stored = createEntry({
    id: 'e8', key: 'a', value: '1', source: 'model', confidence: 0.5, now,
  });
  const shown = sendableToUser([stored]);
  shown[0].provenance = 'FACT';

  assert.equal(stored.provenance, 'INFERENCE');
});
