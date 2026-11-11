/**
 * The feature catalog and its prices (owner direction, 2026-11-10).
 *
 * Every model purpose must be charged to exactly one feature, or a call could
 * spend money no budget sees. The free budgets must fit under the free
 * ceiling, and every purchase's budget must be below what it nets after a 30%
 * store fee, or a paying user could cost more than they pay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_CATALOG,
  GRANT_IDS,
  featureForPurpose,
  featureManifest,
  isFeatureId,
  monthlyBudgetCents,
  type GrantId,
} from '../../lib/features/catalog.ts';
import { centsToNanoUsd, costNanoUsd, nanoUsdToCents, pricedModelFor } from '../../lib/features/pricing.ts';
import type { LlmPurpose } from '../../src/extraction/llm/llmProvider.ts';

const ALL_PURPOSES: readonly LlmPurpose[] = [
  'capture_extraction', 'profile_extraction', 'semantic_observation', 'importance_estimate', 'plan_explanation',
  'share_extraction', 'ai_context_import', 'goal_decomposition', 'meeting_prep', 'capture_chat',
  'memory_summary', 'memory_translate', 'email_triage',
];

test('every model purpose is charged to exactly one feature', () => {
  for (const purpose of ALL_PURPOSES) {
    const owners = FEATURE_CATALOG.filter(manifest => manifest.purposes.includes(purpose));
    assert.equal(owners.length, 1, `${purpose} has ${owners.length} owners`);
    assert.equal(featureForPurpose(purpose), owners[0]!.id);
  }
});

test('Gmail semantic reads are charged to the Gmail add-on, notes to the core assistant', () => {
  assert.equal(featureForPurpose('semantic_observation', { source: 'gmail' }), 'gmail_reading');
  assert.equal(featureForPurpose('semantic_observation'), 'assistant');
});

test('core cannot be switched off; every add-on can', () => {
  for (const manifest of FEATURE_CATALOG) {
    assert.equal(manifest.userCanDisable, manifest.tier === 'addon', manifest.id);
  }
});

test('the free budgets fit under the 40¢ free ceiling', () => {
  const free = FEATURE_CATALOG.reduce((sum, manifest) => sum + (manifest.freeMonthlyCents ?? 0), 0);
  assert.ok(free <= 40, `free budgets sum to ${free}¢`);
});

test('no purchase adds more spend than it nets after 18% VAT and a 30% store fee', () => {
  // What a purchase changes is its own features' budgets: the free allowances
  // are spent by a free user anyway, and the free ceiling holds over them for
  // paying users too (featureGate.ts), so a purchase unlocks nothing else.
  const priceCents: Record<GrantId, number> = {
    base: 300, gmail_light: 400, gmail_full: 500, meeting_prep: 100, goal_plans: 100, memory_plus: 100,
  };
  for (const grant of GRANT_IDS) {
    const net = (priceCents[grant] / 1.18) * 0.7;
    const added = FEATURE_CATALOG.reduce((sum, manifest) => {
      const cents = manifest.grants[grant];
      return cents === undefined ? sum : sum + cents - (manifest.freeMonthlyCents ?? 0);
    }, 0);
    assert.ok(added <= net, `${grant}: adds ${added}¢ of budget vs ${net.toFixed(0)}¢ net`);
  }
});

test('the largest grant wins; grants do not add; a paid-only feature is closed without one', () => {
  assert.equal(monthlyBudgetCents('gmail_reading', new Set()), 15);
  assert.equal(monthlyBudgetCents('gmail_reading', new Set<GrantId>(['gmail_light'])), 135);
  assert.equal(monthlyBudgetCents('gmail_reading', new Set<GrantId>(['gmail_light', 'gmail_full'])), 270);
  assert.equal(monthlyBudgetCents('memory_translation', new Set()), null);
  assert.equal(monthlyBudgetCents('memory_translation', new Set<GrantId>(['memory_plus'])), 20);
  assert.equal(monthlyBudgetCents('football', new Set()), 0);
});

test('unknown ids are refused rather than guessed', () => {
  assert.equal(isFeatureId('gmail_reading'), true);
  assert.equal(isFeatureId('gmail'), false);
  assert.throws(() => featureManifest('nope' as never), /unknown feature/);
});

test('prices are integer nano-dollars per token', () => {
  assert.equal(costNanoUsd('gemini-2.5-flash', { promptTokens: 1000, outputTokens: 100 }), 550_000);
  assert.equal(costNanoUsd('jev', { promptTokens: 1000, outputTokens: 50 }), 42_000);
  assert.equal(costNanoUsd('gemini-2.5-flash', { promptTokens: -5, outputTokens: Number.NaN }), 0);
  assert.equal(pricedModelFor('jev-1.13.0'), 'jev');
  assert.equal(pricedModelFor('gemini-2.0-flash'), 'gemini-2.5-flash');
  assert.equal(pricedModelFor(undefined), 'gemini-2.5-flash');
  assert.equal(centsToNanoUsd(1), 10_000_000);
  assert.equal(nanoUsdToCents(2_100_000), 0.21);
});
