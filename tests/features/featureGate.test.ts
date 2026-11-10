/**
 * The feature gate (owner direction, 2026-11-10): one decision per feature from
 * what was bought, what the person switched off and what was spent this month.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { projectRevenueCatEntitlements } from '../../lib/integrations/revenuecat/entitlements.ts';
import {
  activeGrants,
  readAccountFeatureState,
  saveEntitlementProjection,
  setFeaturePreference,
} from '../../lib/features/accountFeatures.ts';
import {
  decideFeature,
  decideFeatureForPurpose,
  freeMonthlyCents,
  gateMode,
  listFeatureDecisions,
  refuses,
} from '../../lib/features/featureGate.ts';
import { recordFeatureSpend } from '../../lib/features/spendLedger.ts';
import { centsToNanoUsd } from '../../lib/features/pricing.ts';

const NOW = new Date('2026-11-10T21:00:00.000Z');
const ENFORCE = { MAYBESITTER_ADDON_GATE_MODE: 'enforce' };
const SHADOW = { MAYBESITTER_ADDON_GATE_MODE: 'shadow' };

function projection(ids: string[], options: { expiresAt?: string | null; isActive?: boolean } = {}) {
  return projectRevenueCatEntitlements({
    scopeId: 'u1', fetchedAt: NOW.toISOString(), now: NOW.toISOString(),
    entitlements: ids.map(entitlementId => ({
      entitlementId, isActive: options.isActive ?? true, expiresAt: options.expiresAt ?? '2026-12-10T00:00:00.000Z',
      willRenew: true, billingIssueDetectedAt: null, verification: 'verified' as const,
    })),
  });
}

async function quiet<T>(run: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const [warn, error] = [console.warn, console.error];
  console.warn = (line: string) => { logged.push(line); };
  console.error = (line: string) => { logged.push(line); };
  try { return { value: await run(), logged }; } finally { console.warn = warn; console.error = error; }
}

test('mode is off unless set exactly; off allows everything and reads nothing', async () => {
  assert.equal(gateMode({}), 'off');
  assert.equal(gateMode({ MAYBESITTER_ADDON_GATE_MODE: 'ENFORCE ' }), 'enforce');
  assert.equal(gateMode({ MAYBESITTER_ADDON_GATE_MODE: 'on' }), 'off');
  const exploding = { get: async () => { throw new Error('must not read'); } } as unknown as StorageAdapter;
  const decision = await decideFeature('u1', 'memory_translation', { storage: exploding, env: {}, now: NOW });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'gate_off');
  assert.equal(refuses(decision), false);
});

test('a person who bought nothing gets the free allowance, and a paid-only add-on is closed', async () => {
  const storage = createMemoryStorage();
  const gmail = await decideFeature('u1', 'gmail_reading', { storage, env: ENFORCE, now: NOW });
  assert.deepEqual([gmail.allowed, gmail.reason, gmail.monthlyBudgetCents], [true, 'free_allowance', 15]);
  const { value: translation } = await quiet(() => decideFeature('u1', 'memory_translation', { storage, env: ENFORCE, now: NOW }));
  assert.deepEqual([translation.allowed, translation.reason, refuses(translation)], [false, 'not_entitled', true]);
});

test('a purchase raises the budget; an expired one does not, even if still marked active', async () => {
  const storage = createMemoryStorage();
  await saveEntitlementProjection('u1', projection(['gmail_full', 'memory_plus']), { storage, now: NOW });
  const gmail = await decideFeature('u1', 'gmail_reading', { storage, env: ENFORCE, now: NOW });
  assert.deepEqual([gmail.reason, gmail.monthlyBudgetCents], ['entitled', 270]);
  assert.equal((await decideFeature('u1', 'memory_translation', { storage, env: ENFORCE, now: NOW })).allowed, true);

  const later = new Date('2026-12-11T00:00:00.000Z');
  const lapsed = await decideFeature('u1', 'gmail_reading', { storage, env: ENFORCE, now: later });
  assert.deepEqual([lapsed.reason, lapsed.monthlyBudgetCents], ['free_allowance', 15]);
  assert.equal(activeGrants(projection(['gmail_full'], { isActive: false }), NOW).size, 0);
  assert.equal(activeGrants(projection(['not_a_grant']), NOW).size, 0);
  assert.equal(activeGrants(projection(['base'], { expiresAt: null }), NOW).has('base'), true);
});

test('the person can switch an add-on off and back on, never a core feature', async () => {
  const storage = createMemoryStorage();
  await setFeaturePreference('u1', 'football', false, { storage, now: NOW });
  const { value: off } = await quiet(() => decideFeature('u1', 'football', { storage, env: ENFORCE, now: NOW }));
  assert.deepEqual([off.allowed, off.reason], [false, 'user_off']);
  await setFeaturePreference('u1', 'football', true, { storage, now: NOW });
  assert.equal((await decideFeature('u1', 'football', { storage, env: ENFORCE, now: NOW })).allowed, true);
  await assert.rejects(setFeaturePreference('u1', 'assistant', false, { storage, now: NOW }), /core feature/);
  // A core id smuggled into the stored document is ignored, not obeyed.
  await storage.set('users/u1/features/preferences', { v: 1, disabled: ['assistant'], updatedAt: NOW.toISOString() });
  assert.equal((await readAccountFeatureState('u1', { storage, now: NOW })).disabled.size, 0);
});

test('a feature stops at its own budget; others keep going', async () => {
  const storage = createMemoryStorage();
  await recordFeatureSpend('u1', 'meeting_prep', centsToNanoUsd(2), { storage, now: NOW });
  const { value: meeting } = await quiet(() => decideFeature('u1', 'meeting_prep', { storage, env: ENFORCE, now: NOW }));
  assert.deepEqual([meeting.allowed, meeting.reason, meeting.remainingNanoUsd], [false, 'budget_spent', 0]);
  assert.equal((await decideFeature('u1', 'goal_plans', { storage, env: ENFORCE, now: NOW })).allowed, true);
});

test('the free ceiling stops every spending feature for someone who bought nothing', async () => {
  const storage = createMemoryStorage();
  await recordFeatureSpend('u1', 'assistant', centsToNanoUsd(17), { storage, now: NOW });
  await recordFeatureSpend('u1', 'gmail_reading', centsToNanoUsd(14), { storage, now: NOW });
  await recordFeatureSpend('u1', 'memory_learning', centsToNanoUsd(1), { storage, now: NOW });
  const env = { ...ENFORCE, MAYBESITTER_FREE_MONTHLY_CENTS: '30' };
  const { value: goal } = await quiet(() => decideFeature('u1', 'goal_plans', { storage, env, now: NOW }));
  assert.deepEqual([goal.allowed, goal.reason], [false, 'free_cap_spent']);
  // A feature that spends nothing on the model is not stopped by money.
  assert.equal((await decideFeature('u1', 'football', { storage, env, now: NOW })).allowed, true);
  // A purchase raises its own feature only: the free ceiling still holds over
  // the features this person uses on a free allowance (review P1-2).
  await saveEntitlementProjection('u1', projection(['memory_plus']), { storage, now: NOW });
  const { value: stillCapped } = await quiet(() => decideFeature('u1', 'goal_plans', { storage, env, now: NOW }));
  assert.deepEqual([stillCapped.allowed, stillCapped.reason], [false, 'free_cap_spent']);
  // ...and the purchased feature runs on its own budget, outside the ceiling.
  assert.equal((await decideFeature('u1', 'memory_learning', { storage, env, now: NOW })).reason, 'entitled');
  // Buying the assistant moves its 17¢ out of the free pool, which frees the rest.
  await saveEntitlementProjection('u1', projection(['base']), { storage, now: NOW });
  assert.equal((await decideFeature('u1', 'goal_plans', { storage, env, now: NOW })).allowed, true);
});

test('the free ceiling can be lowered by configuration but never raised past 50¢', () => {
  assert.equal(freeMonthlyCents({}), 40);
  assert.equal(freeMonthlyCents({ MAYBESITTER_FREE_MONTHLY_CENTS: '25' }), 25);
  assert.equal(freeMonthlyCents({ MAYBESITTER_FREE_MONTHLY_CENTS: '500' }), 50);
  assert.equal(freeMonthlyCents({ MAYBESITTER_FREE_MONTHLY_CENTS: 'x' }), 40);
});

test('shadow decides and logs but never asks a caller to refuse', async () => {
  const storage = createMemoryStorage();
  const { value, logged } = await quiet(() => decideFeature('u1', 'memory_translation', { storage, env: SHADOW, now: NOW }));
  assert.deepEqual([value.allowed, value.enforced, refuses(value)], [false, false, false]);
  assert.deepEqual(logged, ['[features/gate] shadow_deny feature=memory_translation reason=not_entitled']);
});

test('unreadable state refuses under enforce and allows under shadow', async () => {
  const broken = { get: async () => { throw new Error('offline'); } } as unknown as StorageAdapter;
  const { value: enforced } = await quiet(() => decideFeature('u1', 'assistant', { storage: broken, env: ENFORCE, now: NOW }));
  assert.deepEqual([enforced.reason, refuses(enforced)], ['gate_unavailable', true]);
  const { value: shadow } = await quiet(() => decideFeature('u1', 'assistant', { storage: broken, env: SHADOW, now: NOW }));
  assert.deepEqual([shadow.reason, shadow.allowed, refuses(shadow)], ['gate_unavailable', true, false]);
});

test('the list answers every feature from one read, and purposes route to their feature', async () => {
  const storage = createMemoryStorage();
  const list = await quiet(() => listFeatureDecisions('u1', { storage, env: ENFORCE, now: NOW }));
  assert.equal(list.value.length, 8);
  assert.equal(list.value.find(item => item.featureId === 'assistant')?.tier, 'core');
  const gmailRead = await decideFeatureForPurpose('u1', 'semantic_observation', { source: 'gmail' }, { storage, env: ENFORCE, now: NOW });
  assert.equal(gmailRead.featureId, 'gmail_reading');
});
