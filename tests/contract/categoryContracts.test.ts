/**
 * The commitment-category contract: the catalog, the user's choice of which
 * categories to use, and the gate that decides whether a model's guess becomes
 * a category at all.
 *
 * Following the Sprint 08 lesson that a vocabulary is only as real as the
 * assertion that enumerates it, the catalog is pinned with an exact
 * `deepEqual`: adding a seventh category is a decision this suite forces into
 * review rather than lets drift in.
 *
 * The gate is the part worth testing hardest. Three separate reasons make a
 * guess into `null`, and each one is a different bug if it stops working: a
 * name the model invented, a guess the model was not sure of, and a category
 * this user turned off. `null` is not a seventh category — it is the absence
 * of one, and the difference is what keeps a filter bar from growing a bucket
 * called "unknown" that the user feels obliged to empty.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY_CONFIDENCE_FLOOR,
  COMMITMENT_CATEGORIES,
  COMMITMENT_CATEGORY_SOURCES,
  DEFAULT_CATEGORY_PREFERENCES,
  isCommitmentCategory,
  normalizeCategoryPreferences,
  resolveCategory,
} from '../../src/contracts/v1/categoryContracts';

test('the catalog is exactly the six categories the product ships', () => {
  assert.deepEqual([...COMMITMENT_CATEGORIES], [
    'work',
    'family',
    'health',
    'finance',
    'social',
    'errands',
  ]);
});

test('a category is either one the user stated or one the app inferred', () => {
  assert.deepEqual([...COMMITMENT_CATEGORY_SOURCES], ['inferred', 'user_explicit']);
});

test('null is the absence of a category, not a member of the catalog', () => {
  assert.equal(isCommitmentCategory('unknown'), false);
  assert.equal(isCommitmentCategory('none'), false);
  assert.equal(isCommitmentCategory(null), false);
  assert.equal(isCommitmentCategory('work'), true);
});

test('categorisation ships with every category available and the split turned off', () => {
  assert.deepEqual([...DEFAULT_CATEGORY_PREFERENCES.enabled], [...COMMITMENT_CATEGORIES]);
  assert.equal(DEFAULT_CATEGORY_PREFERENCES.grouping, false);
});

test('a name the model invented is not a category', () => {
  const resolved = resolveCategory('hobbies', 1, DEFAULT_CATEGORY_PREFERENCES);
  assert.equal(resolved, null);
});

test('a guess below the confidence floor is dropped rather than filed wrongly', () => {
  const resolved = resolveCategory('work', CATEGORY_CONFIDENCE_FLOOR - 0.01, DEFAULT_CATEGORY_PREFERENCES);
  assert.equal(resolved, null);
});

test('a guess at the confidence floor is kept', () => {
  const resolved = resolveCategory('work', CATEGORY_CONFIDENCE_FLOOR, DEFAULT_CATEGORY_PREFERENCES);
  assert.equal(resolved, 'work');
});

test('a category the user turned off never reaches a commitment', () => {
  const prefs = normalizeCategoryPreferences({ enabled: ['work', 'family'], grouping: true });
  assert.equal(resolveCategory('health', 1, prefs), null);
  assert.equal(resolveCategory('work', 1, prefs), 'work');
});

test('the split being off does not stop the app from filing what it captures', () => {
  const prefs = normalizeCategoryPreferences({ enabled: ['work'], grouping: false });
  assert.equal(resolveCategory('work', 1, prefs), 'work');
});

test('preferences from storage keep only names the catalog still has', () => {
  const prefs = normalizeCategoryPreferences({ enabled: ['work', 'hobbies', 'family'], grouping: true });
  assert.deepEqual([...prefs.enabled], ['work', 'family']);
});

test('preferences that are missing or malformed fall back to the defaults', () => {
  assert.deepEqual(normalizeCategoryPreferences(undefined), DEFAULT_CATEGORY_PREFERENCES);
  assert.deepEqual(normalizeCategoryPreferences({ enabled: 'work' }), DEFAULT_CATEGORY_PREFERENCES);
  assert.deepEqual(normalizeCategoryPreferences(null), DEFAULT_CATEGORY_PREFERENCES);
});

test('a user who disables every category still gets a well-formed preference', () => {
  const prefs = normalizeCategoryPreferences({ enabled: [], grouping: true });
  assert.deepEqual([...prefs.enabled], []);
  assert.equal(prefs.grouping, true);
  assert.equal(resolveCategory('work', 1, prefs), null);
});
