/**
 * What the extraction prompt says about categories (#415).
 *
 * The load-bearing case is the third one: the model is only ever shown the
 * categories this user kept. A prompt that always listed all six would produce
 * `health` for somebody who turned `health` off, and `resolveCategory` would
 * then throw it away — the answer would be right, but the model would have
 * spent its reasoning on a category that could never be used, and every
 * evaluation of how well it categorises would be measuring the wrong thing.
 *
 * The fourth case is the one that is easy to get wrong in the other direction:
 * a user with no categories at all must not be sent a prompt with an empty
 * list, which reads to a model as an instruction with a missing argument. They
 * are told plainly not to categorise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt } from '../../src/extraction/ollamaExtractor.ts';
import { COMMITMENT_CATEGORIES } from '../../src/contracts/v1/categoryContracts.ts';

const base = { now: new Date('2026-04-08T09:00:00.000Z'), timezone: 'Asia/Jerusalem' };

test('the prompt names category among the keys the model may return', () => {
  const prompt = buildPrompt('Send the invoice', base);
  assert.match(prompt, /only allowed top-level keys are:.*\bcategory\b/);
  assert.match(prompt, /only allowed top-level keys are:.*\bcategoryConfidence\b/);
});

test('a user who has chosen nothing is offered the whole catalog', () => {
  const prompt = buildPrompt('Send the invoice', base);
  for (const category of COMMITMENT_CATEGORIES) {
    assert.ok(prompt.includes(category), `the prompt must offer ${category}`);
  }
});

test('the model is offered only the categories this user kept', () => {
  const prompt = buildPrompt('Send the invoice', { ...base, categories: ['work', 'family'] });
  assert.match(prompt, /Allowed category values: work, family/);
  for (const absent of ['health', 'finance', 'social', 'errands']) {
    assert.ok(
      !new RegExp(`Allowed category values:[^\\n]*${absent}`).test(prompt),
      `${absent} must not be offered`,
    );
  }
});

test('a user who uses no categories is told not to categorise, not given an empty list', () => {
  const prompt = buildPrompt('Send the invoice', { ...base, categories: [] });
  assert.ok(!/Allowed category values:\s*$/m.test(prompt), 'no empty list');
  assert.match(prompt, /category must always be null/);
});

test('the prompt tells the model that guessing is worse than saying nothing', () => {
  const prompt = buildPrompt('Send the invoice', base);
  assert.match(prompt, /null/);
  assert.match(prompt, /categoryConfidence/);
});
