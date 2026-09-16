/**
 * A kept focus window reaches the daily plan, and deleting it takes it away
 * (UC-3.16, #202, step 3).
 *
 * Only R1 feeds planning, only as a hint for an account whose routine names no
 * focus window, and only with personalization consent. Each of those is a
 * separate case below, and the end-to-end cases build a real plan document
 * rather than inspecting the adapter's arguments.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { buildDailyPlanInput } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { composeDailyPlan } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { setPersonalizationConsent } from '../../lib/consents/personalizationConsentService.ts';
import { PERSONALIZATION_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { deleteMemory } from '../../lib/services/mobile/memoryService.ts';
import { keptFocusWindow } from '../../lib/memoryGrowth/suggestionService.ts';
import type { UserRoutineProfile } from '../../src/contracts/v1/routineContracts.ts';

const UID = 'plan_hint_user';
const ZONE = 'Asia/Jerusalem';
const DATE = '2026-09-17';
const NOW = '2026-09-16T21:30:00.000Z';

function windowsOf(constraints: { workingWindows: ReadonlyArray<{ startMinute: number; endMinute: number }> }) {
  return constraints.workingWindows.map((window) => [window.startMinute, window.endMinute]);
}

async function keepR1(storage: StorageAdapter, fingerprint = 'R1_focus_window:09:00-12:00', source: 'deterministic_rule' | 'user_stated' = 'deterministic_rule') {
  return createStorageRuntimeMemoryStore(undefined, storage).put({
    scopeId: UID,
    kind: 'preference',
    content: 'You often finish things between 09:00 and 12:00.',
    language: 'en',
    source,
    confidence: 0.7,
    observedAt: NOW,
    evidenceIds: ['ev1', 'ev2'],
    provenance: { origin: 'behaviour_rule', originRef: fingerprint, confirmedByUserAt: NOW },
  }, NOW);
}

async function account(consent: 'enabled' | 'disabled' | null): Promise<StorageAdapter> {
  const storage = createMemoryStorage();
  await storage.set(userDoc(UID), { uid: UID, timezone: ZONE });
  if (consent) {
    await setPersonalizationConsent(UID, {
      state: consent === 'enabled' ? 'granted' : 'declined',
      version: PERSONALIZATION_CONSENT_VERSION,
      at: new Date(NOW),
    }, { storage });
  }
  return storage;
}

async function planWindows(storage: StorageAdapter): Promise<number[][]> {
  const stored = await composeDailyPlan(UID, DATE, { timezone: ZONE }, 1, {
    storage,
    now: () => new Date(NOW),
    busyBlocks: async () => [],
  });
  return windowsOf(stored.constraints);
}

test('the adapter uses a focus hint only when the routine names no focus window', () => {
  const base = { uid: UID, date: DATE, timezone: ZONE, commitments: [], busyBlocks: [] };
  const hinted = buildDailyPlanInput({ ...base, profile: null, focusHint: { start: '09:00', end: '12:00' } });
  assert.deepEqual(windowsOf(hinted.constraints), [[540, 720]]);

  const withRoutine = buildDailyPlanInput({
    ...base,
    profile: { focusWindows: [{ start: '13:00', end: '17:00', label: 'work_study' }], sleepWindow: null } as unknown as UserRoutineProfile,
    focusHint: { start: '09:00', end: '12:00' },
  });
  assert.deepEqual(windowsOf(withRoutine.constraints), [[780, 1020]], 'what the user said about their day outranks a pattern');

  // A late habit ends at the end of the day, and is still a window the planner can use.
  const late = buildDailyPlanInput({ ...base, profile: null, focusHint: { start: '21:00', end: '24:00' } });
  assert.deepEqual(windowsOf(late.constraints), [[1260, 1440]]);

  const none = buildDailyPlanInput({ ...base, profile: null });
  assert.deepEqual(windowsOf(none.constraints), [[480, 1200]]);
});

test('a kept R1 window shapes the next plan, and deleting it removes that on the plan after', async () => {
  const storage = await account('enabled');
  const kept = await keepR1(storage);
  assert.deepEqual(await planWindows(storage), [[540, 720]]);

  await deleteMemory(UID, kept.id, NOW, { storage, memory: createStorageRuntimeMemoryStore(undefined, storage) });
  assert.deepEqual(await planWindows(storage), [[480, 1200]]);
});

test('without personalization consent a kept window does not reach the plan', async () => {
  for (const consent of [null, 'disabled'] as const) {
    const storage = await account(consent);
    await keepR1(storage);
    assert.deepEqual(await planWindows(storage), [[480, 1200]], `consent ${String(consent)}`);
  }
});

test('a kept window the user rewrote in their own words is not parsed back into a window', async () => {
  const storage = await account('enabled');
  await keepR1(storage, 'R1_focus_window:09:00-12:00', 'user_stated');
  assert.equal(await keptFocusWindow(UID, NOW, { storage }), null);
  assert.deepEqual(await planWindows(storage), [[480, 1200]]);
});

test('a fingerprint this version cannot read is ignored rather than half-understood', async () => {
  const storage = await account('enabled');
  await keepR1(storage, 'R1_focus_window:09:30-12:30');
  assert.equal(await keptFocusWindow(UID, NOW, { storage }), null);
});
