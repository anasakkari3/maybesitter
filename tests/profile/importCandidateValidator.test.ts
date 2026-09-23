/**
 * What survives between another assistant's prose and the user's screen.
 *
 * ── A wrong link is not a wrong claim ────────────────────────────
 *
 * Every other validator in this repo drops what it cannot trust, and this one
 * does too — except for `relation`. A candidate that says "this updates item
 * 41" when only forty were shown has got the *linkage* wrong while the
 * sentence about the person may be perfectly true. Dropping it throws away a
 * fact to punish a citation. So those two cases demote to `new` and are kept,
 * and the counter says which happened.
 *
 * The other thing this file exists for is the case `profileSuggestionValidator`
 * was written for: a model returning "has ADHD and takes Ritalin", well
 * formed and confident. The prompt asks; this refuses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImportCandidates } from '../../src/profile/importCandidateValidator.ts';
import { MAX_CANDIDATE_LENGTH, MAX_IMPORT_CANDIDATES } from '../../src/profile/aiContextImportContracts.ts';

const NOW = new Date('2026-09-23T09:00:00.000Z');

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'goal',
    category: 'learning',
    content: 'Finish the thesis',
    targetDate: '2027-03-01',
    confidence: 0.9,
    relation: 'new',
    relatesTo: null,
    ...overrides,
  };
}

function run(candidates: unknown[], options: { existingCount?: number; existing?: string[] } = {}) {
  return validateImportCandidates({ candidates }, {
    now: NOW,
    existingCount: options.existingCount ?? 3,
    existingContents: new Set(options.existing ?? []),
  });
}

test('a well formed candidate survives', () => {
  const outcome = run([candidate()]);
  assert.equal(outcome.candidates.length, 1);
  assert.deepEqual(outcome.dropped, {});
});

test('a relation off the union is dropped', () => {
  const outcome = run([candidate({ relation: 'supersedes' })]);
  assert.equal(outcome.candidates.length, 0);
  assert.equal(outcome.dropped.unknown_relation, 1);
});

test('an update pointing past the list is demoted, not dropped', () => {
  const outcome = run([candidate({ relation: 'update', relatesTo: 41 })], { existingCount: 40 });
  assert.equal(outcome.candidates.length, 1, 'the claim was thrown away with the citation');
  assert.equal(outcome.candidates[0]!.relation, 'new');
  assert.equal(outcome.candidates[0]!.relatesTo, null);
  assert.equal(outcome.dropped.unresolvable_relation, 1);
});

test('an out of range index is never clamped to the last record', () => {
  // Clamping would silently supersede whichever record happened to be fortieth.
  const outcome = run([candidate({ relation: 'conflict', relatesTo: 41 })], { existingCount: 40 });
  assert.equal(outcome.candidates[0]!.relatesTo, null);
  assert.notEqual(outcome.candidates[0]!.relation, 'conflict');
});

test('an update with no index at all is demoted', () => {
  const outcome = run([candidate({ relation: 'update', relatesTo: null })]);
  assert.equal(outcome.candidates[0]!.relation, 'new');
  assert.equal(outcome.dropped.unresolvable_relation, 1);
});

test('a non-integer index is demoted', () => {
  const outcome = run([candidate({ relation: 'update', relatesTo: 1.5 })]);
  assert.equal(outcome.candidates[0]!.relation, 'new');
  assert.equal(outcome.dropped.unresolvable_relation, 1);
});

test('a new candidate carrying an index keeps the claim and loses the index', () => {
  const outcome = run([candidate({ relation: 'new', relatesTo: 2 })]);
  assert.equal(outcome.candidates.length, 1);
  assert.equal(outcome.candidates[0]!.relatesTo, null);
  assert.equal(outcome.dropped.spurious_relation, 1);
});

test('a resolvable update keeps its index', () => {
  const outcome = run([candidate({ relation: 'update', relatesTo: 2 })], { existingCount: 3 });
  assert.equal(outcome.candidates[0]!.relation, 'update');
  assert.equal(outcome.candidates[0]!.relatesTo, 2);
});

test('content the account already holds is dropped', () => {
  const outcome = run([candidate({ content: 'Finish the thesis' })], { existing: ['finish the thesis'] });
  assert.equal(outcome.candidates.length, 0);
  assert.equal(outcome.dropped.duplicate_of_existing, 1);
});

test('duplicate matching ignores case, spacing and trailing punctuation', () => {
  const outcome = run([candidate({ content: '  Finish   the Thesis.  ' })], { existing: ['finish the thesis'] });
  assert.equal(outcome.dropped.duplicate_of_existing, 1);
});

test('the same claim twice in one response is kept once', () => {
  const outcome = run([candidate(), candidate({ confidence: 0.7 })]);
  assert.equal(outcome.candidates.length, 1);
  assert.equal(outcome.dropped.duplicate_candidate, 1);
});

test('a sensitive claim is refused however well formed', () => {
  const outcome = run([candidate({ content: 'Has ADHD and takes Ritalin', confidence: 0.99 })]);
  assert.equal(outcome.candidates.length, 0);
  assert.equal(outcome.dropped.sensitive, 1);
});

test('a candidate longer than the cap is dropped', () => {
  const outcome = run([candidate({ content: 'م'.repeat(MAX_CANDIDATE_LENGTH + 1) })]);
  assert.equal(outcome.dropped.too_long, 1);
});

test('a candidate exactly at the cap survives', () => {
  const outcome = run([candidate({ content: 'م'.repeat(MAX_CANDIDATE_LENGTH) })]);
  assert.equal(outcome.candidates.length, 1);
});

test('confidence below the floor is dropped', () => {
  const outcome = run([candidate({ confidence: 0.59 })]);
  assert.equal(outcome.dropped.low_confidence, 1);
});

test('an unknown kind or category is dropped', () => {
  const outcome = run([candidate({ kind: 'diagnosis' }), candidate({ category: 'health', content: 'x' })]);
  assert.equal(outcome.candidates.length, 0);
  assert.equal(outcome.dropped.unknown_kind, 1);
  assert.equal(outcome.dropped.unknown_category, 1);
});

test('a past target date is dropped', () => {
  const outcome = run([candidate({ targetDate: '2020-01-01' })]);
  assert.equal(outcome.dropped.past_target_date, 1);
});

test('nothing beyond the candidate cap is kept', () => {
  const many = Array.from({ length: MAX_IMPORT_CANDIDATES + 4 }, (_, i) =>
    candidate({ content: `Candidate number ${i}` }));
  const outcome = run(many);
  assert.equal(outcome.candidates.length, MAX_IMPORT_CANDIDATES);
  assert.equal(outcome.dropped.over_limit, 4);
});

test('a response that is not a candidate list yields nothing', () => {
  for (const raw of [null, undefined, 'candidates', 42, {}, { candidates: 'no' }]) {
    const outcome = validateImportCandidates(raw, { now: NOW, existingCount: 0, existingContents: new Set() });
    assert.equal(outcome.candidates.length, 0);
  }
});
