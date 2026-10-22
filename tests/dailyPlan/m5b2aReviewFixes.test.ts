/**
 * M5b-2a Task A inspection r1, server half (Codex M5B2A-REV-004, REV-007).
 * Built on the M5b-2a Gate B harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { readPlanMemoryProjection } from '../../lib/services/dailyPlan/planMemoryBasis.ts';
import { assemblePlanResponse } from '../../lib/services/dailyPlan/planDto.ts';
import { buildDailyPlanOnDemand, composeDailyPlan, memoryFocusForPlan, personalizationPurgeMatches } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { acceptPlan } from '../../lib/services/dailyPlan/planActions.ts';
import { processStateChangesForUser } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { PlanWriteGuardRejected, planPath } from '../../lib/services/dailyPlan/planStore.ts';
import { acceptWeekDay, composeWeek } from '../../lib/services/dailyPlan/weekPlan.ts';
import { createStoragePersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import { fencedPersonalizationConsentStore, setPersonalizationConsent, PersonalizationConsentNotRecordedError, PersonalizationWithdrawalBusyError, PERSONALIZATION_CONSENT_VERSION } from '../../lib/consents/personalizationConsentService.ts';
import { readFileSync } from 'node:fs';
import { POST as personalizationControlsPost } from '../../src/app/api/personalization/route.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { setStorageForTests } from '../../lib/storage/index.ts';
import {
  AUTO_APPLY, NOW, REVIEW, TODAY, TZ, addFloating, begin, buildPlan, call, currentStorage, end,
  getPlan, grantPersonalization, grantRecommendations, meetingLands, outcomeObservation, replan, setAccount, show, storedPlan,
  storeSuggestion, storedSuggestion, threeTasks, touchPlan,
} from '../acceptance/m5b2a/support.ts';

test.afterEach(() => end());

async function keptFocusPlan(): Promise<string> {
  const uid = await begin();
  await grantPersonalization(uid);
  await threeTasks(uid);
  await storeKeptFocus(uid);
  const built = await buildPlan(uid);
  assert.ok(built.memoryBasis, 'fixture: no basis');
  return uid;
}

async function storeKeptFocus(uid: string, originRef = 'R1_focus_window:09:00-12:00'): Promise<void> {
  await createStorageRuntimeMemoryStore(undefined, currentStorage() as any).put({
    scopeId: uid, kind: 'preference', content: 'You often finish things between 09:00 and 12:00.', language: 'en',
    source: 'deterministic_rule', confidence: 0.7, observedAt: NOW(), evidenceIds: ['ev1', 'ev2'],
    provenance: { origin: 'behaviour_rule', originRef, confirmedByUserAt: NOW() },
  } as any, NOW());
}

async function offModeFocusAccount(originRef?: string): Promise<string> {
  const uid = await begin({ on: false });
  await grantPersonalization(uid);
  await threeTasks(uid);
  await storeKeptFocus(uid, originRef);
  return uid;
}

function workingWindows(stored: any): number[][] {
  return stored.constraints.workingWindows.map((window: any) => [window.startMinute, window.endMinute]);
}

async function makeSuppressedWindowMatchKeptWindow(uid: string): Promise<void> {
  await setAccount(uid, { profile: { routine: {
    schemaVersion: 1,
    updatedAt: NOW(),
    timezone: TZ,
    sleepWindow: { start: '12:00', end: '09:00' },
    focusWindows: [],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'followUp',
    quietHours: null,
    surveySkipped: false,
  } } });
}

async function replanWithWithdrawalAtWrite(
  uid: string,
  policyConfig: Record<string, unknown>,
  interval: { startsAt: string; endsAt: string },
  blockId: string,
): Promise<any> {
  const change = await meetingLands(uid, interval, blockId);
  const real = currentStorage() as any;
  let armed = false;
  let withdrew = false;
  const storage = new Proxy(real, {
    get(target, key) {
      if (key === 'runTransaction') {
        return async (fn: (tx: any) => Promise<unknown>) => {
          return target.runTransaction((tx: any) => fn(new Proxy(tx, {
            get(inner, property) {
              const member = Reflect.get(inner, property);
              if (property === 'get' && typeof member === 'function') {
                return async (path: string, ...rest: unknown[]) => {
                  if (path === planPath(uid, TODAY)) armed = true;
                  const value = await member.call(inner, path, ...rest);
                  if (path === userDoc(uid) && armed && !withdrew) {
                    withdrew = true;
                    const epoch = (value?.personalizationPurge?.epoch ?? 0) + 1;
                    return { ...(value ?? {}), personalizationPurge: { state: 'withdrawing', epoch } };
                  }
                  return value;
                };
              }
              return typeof member === 'function' ? member.bind(inner) : member;
            },
          })));
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const report = await processStateChangesForUser(uid, {
    storage,
    now: new Date(),
    date: TODAY,
    changes: [change],
    entityFactsByChangeId: new Map([[change.changeId, { interval, blocking: true }]]) as any,
    policyConfig: policyConfig as any,
  });
  assert.ok(withdrew, 'fixture: withdrawal never landed at the replan write');
  return report;
}

test('REV-004: a purge that begins between the two reads of the projection shows no basis', async () => {
  const uid = await keptFocusPlan();
  const stored = await storedPlan(uid);
  const real = currentStorage() as any;
  let userReads = 0;
  const racing = new Proxy(real, {
    get(target, key) {
      if (key !== 'get') return Reflect.get(target, key);
      return async (path: string) => {
        const value = await target.get(path);
        if (path !== userDoc(uid)) return value;
        userReads += 1;
        // The second read of the user document sees a purge that began after the first.
        return userReads >= 2 ? { ...(value ?? {}), personalizationPurge: { state: 'purging', epoch: 1, startedAt: NOW() } } : value;
      };
    },
  });
  const projection = await readPlanMemoryProjection(uid, stored, NOW(), racing);
  assert.ok(userReads >= 2, 'fixture: the projection read the user document once');
  assert.equal(projection.memoryBasis, null, show(projection));
});

test('REV-007: an outcome whose title spans lines still gets its signal and title', async () => {
  const uid = await begin();
  const multi = await outcomeObservation(uid, 'Completed: First line\nsecond line', '0e0e0e0e-0000-4000-8000-000000000099');
  const inbox = await call(uid, 'intelligence', 'GET');
  assert.equal(inbox.status, 200, show(inbox.body));
  const row = inbox.body.observations.find((item: any) => item.id === multi.id);
  assert.deepEqual(row.outcome, { signal: 'completed', title: 'First line\nsecond line' });
});

test('R2-001: withdrawing personalization consent moves the fence, so a plan that read the window before it writes no memory marker', async () => {
  const uid = await keptFocusPlan();
  const before = ((await currentStorage().get<Record<string, any>>(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  let fired = false;
  const stored = await composeDailyPlan(uid, TODAY, { timezone: TZ }, 2, {
    storage: currentStorage() as any,
    now: () => new Date(),
    busyBlocks: async () => {
      if (!fired) {
        fired = true;
        await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
      }
      return [];
    },
  } as any);
  assert.ok(fired, 'fixture: the busy read never ran');
  const after = ((await currentStorage().get<Record<string, any>>(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  assert.equal(after, before + 1, 'the withdrawal did not move the fence');
  assert.equal((stored as any).focusFromMemory, false, show((stored as any).focusFromMemory));
});

test('R4-001: a plan that resolves the window just as withdrawal begins is refused by the fence the withdrawal moves', async () => {
  const uid = await keptFocusPlan();
  const base = createStoragePersonalizationConsentStore(currentStorage() as any);
  let raced: Awaited<ReturnType<typeof memoryFocusForPlan>> | undefined;
  const consent = {
    ...base,
    read: base.read.bind(base),
    write: async (...args: Parameters<typeof base.write>) => {
      // The last moment a reader can still see consent on: just before the
      // store is disabled.
      if (args[1] === 'disabled' && raced === undefined) raced = await memoryFocusForPlan(uid, NOW(), { storage: currentStorage() as any });
      return base.write(...args);
    },
  };
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any, consent: consent as any });
  assert.notEqual(raced, undefined, 'fixture: the racing plan never ran');
  // Since R7-001 the closed fence gives it no window at all; either way, a
  // plan shaped by the withdrawn window is never written.
  const user = await currentStorage().get(userDoc(uid));
  assert.ok(raced === null || !personalizationPurgeMatches(user, raced!.purgeEpoch), 'a plan shaped by the withdrawn window would still be written');
  const later = await memoryFocusForPlan(uid, NOW(), { storage: currentStorage() as any });
  assert.equal(later, null, 'a plan begun after the withdrawal still reads the window');
});

test('R6-002: a memory projection that cannot be read omits the basis instead of failing the plan response', async () => {
  const uid = await keptFocusPlan();
  const stored = await storedPlan(uid);
  const storage = currentStorage() as any;
  const healthy = await assemblePlanResponse(uid, stored, NOW(), new Map(), { storage });
  assert.ok((healthy as any).memoryBasis, 'fixture: no basis to omit');
  const failing = new Proxy(storage, {
    get(target, key) {
      if (key === 'get') return async () => { throw new Error('projection read failed'); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const dto = await assemblePlanResponse(uid, stored, NOW(), new Map(), { storage: failing });
  assert.equal((dto as any).memoryBasis, undefined);
  assert.equal((dto as any).memoryBasisChanged, undefined);
  assert.equal(dto.date, (healthy as any).date);
  assert.deepEqual(dto.scheduled, (healthy as any).scheduled);
});

test('R7-001: between the phases of a withdrawal nothing reads the kept window, shows its basis, or writes with the old epoch', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const stored = await storedPlan(uid);
  const oldEpoch = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  const base = createStoragePersonalizationConsentStore(storage);
  const seen: Record<string, unknown> = {};
  const consent = {
    ...base,
    read: base.read.bind(base),
    write: async (...args: Parameters<typeof base.write>) => {
      if (args[1] !== 'disabled') return base.write(...args);
      // Just before the store is disabled: consent still reads on.
      seen.focusBefore = await memoryFocusForPlan(uid, NOW(), { storage });
      seen.basisBefore = (await readPlanMemoryProjection(uid, stored, NOW(), storage)).memoryBasis;
      const written = await base.write(...args);
      // Just after it, before the fence reopens: a plan that read the window
      // earlier tries its guarded write.
      seen.oldEpochWrites = personalizationPurgeMatches(await storage.get(userDoc(uid)), oldEpoch);
      return written;
    },
  };
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: consent as any });
  assert.equal(seen.focusBefore, null, 'a plan read the kept window during the withdrawal');
  assert.equal(seen.basisBefore, null, 'a basis was shown during the withdrawal');
  assert.equal(seen.oldEpochWrites, false, 'a plan that read the window before the withdrawal could still write');
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.equal(fence?.state, 'active', 'the fence did not reopen');
  assert.equal(fence?.epoch, oldEpoch + 1);
});

test('R7-001: a withdrawal whose store write fails still reopens the fence at the moved epoch', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const oldEpoch = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  const base = createStoragePersonalizationConsentStore(storage);
  const consent = { ...base, read: base.read.bind(base), write: async () => { throw new Error('store unavailable'); } };
  await assert.rejects(setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: consent as any }));
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.epoch], ['active', oldEpoch + 1]);
});

/** The same storage, with every read of the runtime-memory collection failing: only the optional projection reads it on these paths. */
function memoryUnreadable(storage: any): any {
  const failing = (path: unknown) => typeof path === 'string' && /\/memory(\/|$)/.test(path);
  return new Proxy(storage, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === 'list' || key === 'listGroup') {
        return async (path: unknown, ...rest: unknown[]) => {
          if (failing(path) || key === 'listGroup') throw new Error('memory unreadable');
          return value.call(target, path, ...rest);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('R7-003: GET and building over an existing plan answer the plan without a basis when the memory projection cannot be read', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const before = await storedPlan(uid);
  setStorageForTests(memoryUnreadable(storage));
  try {
    const read = await call(uid, 'plans/[date]', 'GET', { params: { date: TODAY } });
    assert.equal(read.status, 200, show(read.body));
    assert.equal(read.body.plan.memoryBasis, undefined);
    assert.equal(read.body.plan.date, TODAY);
    const built = await call(uid, 'plans/[date]/build', 'POST', { params: { date: TODAY } });
    assert.equal(built.status, 200, show(built.body));
    assert.equal(built.body.plan.memoryBasis, undefined);
  } finally {
    setStorageForTests(storage);
  }
  assert.equal((await storedPlan(uid)).generation, before.generation, 'an unreadable projection rebuilt the plan');
});

/** Sets the personalization fence as a purge's own transaction would. */
async function setFence(storage: any, uid: string, fence: Record<string, unknown>): Promise<void> {
  await storage.runTransaction(async (tx: any) => { tx.merge(userDoc(uid), { personalizationPurge: fence }); });
}

test('R8-003: a withdrawal behind a running purge waits for it and takes its own epoch, refusing a plan that read the window under the purge epoch', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const prior = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  const purgeEpoch = prior + 1;
  await setFence(storage, uid, { state: 'purging', epoch: purgeEpoch });
  let underPurgeEpoch: Awaited<ReturnType<typeof memoryFocusForPlan>> = null;
  const withdrawal = setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, {
    storage, purgeWait: { attempts: 50, delayMs: 5 },
  });
  // The purge finishes while the withdrawal waits; a plan then reads the window under its epoch.
  await new Promise((resolve) => setTimeout(resolve, 12));
  await setFence(storage, uid, { state: 'active', epoch: purgeEpoch });
  underPurgeEpoch = await memoryFocusForPlan(uid, NOW(), { storage });
  await withdrawal;
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.epoch], ['active', purgeEpoch + 1], 'the withdrawal did not take its own epoch');
  assert.ok(underPurgeEpoch, 'fixture: no plan read the window between the purge and the withdrawal');
  assert.equal(personalizationPurgeMatches({ personalizationPurge: fence }, underPurgeEpoch!.purgeEpoch), false, 'a plan read under the purge epoch would still be written');
});

test('R8-003: a purge that outlasts the wait fails the withdrawal before anything changes', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const prior = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  await setFence(storage, uid, { state: 'purging', epoch: prior + 1 });
  const base = createStoragePersonalizationConsentStore(storage);
  let writes = 0;
  const consent = { ...base, read: base.read.bind(base), write: async (...args: Parameters<typeof base.write>) => { writes += 1; return base.write(...args); } };
  await assert.rejects(
    setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: consent as any, purgeWait: { attempts: 3, delayMs: 1 } }),
    PersonalizationWithdrawalBusyError,
  );
  assert.equal(writes, 0, 'the store was disabled although the withdrawal failed');
  assert.equal((await base.read(uid)).state, 'enabled');
});

test('R10-001: off-mode build retries without the kept window when withdrawal lands between read and write', async () => {
  const uid = await offModeFocusAccount();
  const real = currentStorage() as any;
  let armed = false;
  let withdrew = false;
  const storage = new Proxy(real, {
    get(target, key) {
      if (key === 'runTransaction') {
        return async (fn: (tx: any) => Promise<unknown>) => {
          if (armed && !withdrew) {
            withdrew = true;
            await setPersonalizationConsent(
              uid,
              { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() },
              { storage: real },
            );
          }
          return target.runTransaction(fn);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const built = await buildDailyPlanOnDemand(uid, TODAY, {
    storage,
    now: () => new Date(),
    busyBlocks: async () => {
      armed = true;
      return [];
    },
  });
  assert.ok(withdrew, 'fixture: withdrawal never landed between the solve and its write');
  assert.equal(built.created, true);
  assert.equal(built.stored.memoryUse, undefined, 'the suppressed retry still claims memory use');
  assert.equal(built.stored.focusFromMemory, undefined, 'off-mode wire provenance leaked into storage');
  assert.notDeepEqual(workingWindows(built.stored), [[540, 720]], 'the stored plan still uses the withdrawn window');
});

test('R10-001 (Claude review): an off-mode account whose fence has already moved still plans with its kept window', async () => {
  const uid = await offModeFocusAccount();
  // An earlier purge or withdrawal-and-regrant left the fence at a later epoch.
  await setFence(currentStorage() as any, uid, { state: 'active', epoch: 3 });
  const built = await buildDailyPlanOnDemand(uid, TODAY, { storage: currentStorage() as any, now: () => new Date(), busyBlocks: async () => [] });
  assert.equal(built.created, true);
  assert.deepEqual(built.stored.memoryUse, { epoch: 3 }, 'the off-mode read did not record the real fence');
  assert.deepEqual(workingWindows(built.stored), [[540, 720]], 'a moved fence silently dropped the kept window');
});

test('R10-001: an off-mode proposal is stale and withdrawn after consent withdrawal', async () => {
  const uid = await offModeFocusAccount();
  await buildPlan(uid);
  await replan(uid, REVIEW);
  const offered = await storedPlan(uid);
  assert.ok(offered.proposal?.memoryUse, 'fixture: the off-mode offer has no internal memory provenance');

  await setPersonalizationConsent(
    uid,
    { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() },
    { storage: currentStorage() as any },
  );
  const response = await call(uid, 'plans/[date]/actions', 'POST', {
    params: { date: TODAY },
    body: { action: 'accept_proposal', proposalId: offered.proposal.proposalId },
  });
  assert.equal(response.status, 422, show(response.body));
  assert.equal(response.body.reason, 'stale_proposal');
  const after = await storedPlan(uid);
  assert.equal(after.generation, offered.generation, 'the stale offer was installed');
  assert.equal(after.proposal, null, 'the stale offer was not withdrawn');
});

test('R10-001: a legacy proposal with no provenance fails closed after the fence moves', async () => {
  const uid = await offModeFocusAccount();
  await buildPlan(uid);
  await replan(uid, REVIEW);
  const stored = await storedPlan(uid);
  assert.ok(stored.proposal, 'fixture: no offer');
  const {
    memoryUse: _memoryUse,
    focusFromMemory: _focusFromMemory,
    personalizationPurgeEpoch: _purgeEpoch,
    storedPurgeEpoch: _storedPurgeEpoch,
    ...legacyProposal
  } = stored.proposal;
  await currentStorage().set(planPath(uid, TODAY), { ...stored, proposal: legacyProposal });

  await setPersonalizationConsent(
    uid,
    { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() },
    { storage: currentStorage() as any },
  );
  const response = await call(uid, 'plans/[date]/actions', 'POST', {
    params: { date: TODAY },
    body: { action: 'accept_proposal', proposalId: legacyProposal.proposalId },
  });
  assert.equal(response.status, 422, show(response.body));
  assert.equal(response.body.reason, 'stale_proposal');
  assert.equal((await storedPlan(uid)).proposal, null, 'the unknowable legacy offer was not withdrawn');
});

test('R10-001/R10-003: off-mode week acceptance and an ordinary accept both refuse a withdrawn memory-shaped plan', async () => {
  const uid = await begin({ on: false });
  await grantPersonalization(uid);
  await addFloating(uid, 'Write the weekly report');
  await storeKeptFocus(uid);
  const real = currentStorage() as any;
  const layout = await composeWeek(uid, { moves: [], drops: [] }, { storage: real, now: () => new Date() });
  const day = layout.days.find((candidate) => candidate.kind === 'proposed' && candidate.plan.scheduled.length > 0);
  assert.ok(day?.kind === 'proposed' && day.memoryUse, 'fixture: no proposed day used the kept window');
  const targetDate = day.date;

  let ordinaryAcceptRefused = false;
  let raced = false;
  const storage = new Proxy(real, {
    get(target, key) {
      if (key === 'runTransaction') {
        return async (fn: (tx: any) => Promise<unknown>) => {
          let createdPlan = false;
          const result = await target.runTransaction((tx: any) => fn(new Proxy(tx, {
            get(inner, property) {
              const member = Reflect.get(inner, property);
              if ((property === 'set' || property === 'create') && typeof member === 'function') {
                return (path: string, ...rest: unknown[]) => {
                  if (path === planPath(uid, targetDate)) createdPlan = true;
                  return member.call(inner, path, ...rest);
                };
              }
              return typeof member === 'function' ? member.bind(inner) : member;
            },
          })));
          if (createdPlan && !raced) {
            raced = true;
            await setPersonalizationConsent(
              uid,
              { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() },
              { storage: real },
            );
            try {
              await acceptPlan(uid, targetDate, { storage: real, now: () => new Date() });
            } catch (error) {
              if (!(error instanceof PlanWriteGuardRejected)) throw error;
              ordinaryAcceptRefused = true;
            }
          }
          return result;
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const outcome = await acceptWeekDay(
    uid,
    targetDate,
    { moves: [], drops: [] },
    day.assignment.include,
    { storage, now: () => new Date() },
  );
  assert.ok(raced, 'fixture: the plan was never stored');
  assert.equal(ordinaryAcceptRefused, true, 'ordinary accept bypassed the stored provenance fence');
  assert.equal(outcome.outcome, 'week_changed');
  assert.equal(await real.get(planPath(uid, targetDate)), null, 'the refused week plan was left behind');
});

test('R10-002: a withdrawn pending offer is freshly re-solved and replaced without memory', async () => {
  const uid = await offModeFocusAccount();
  await makeSuppressedWindowMatchKeptWindow(uid);
  await buildPlan(uid);
  const slot = (await storedPlan(uid)).plan.scheduled[0].interval;
  const inside = {
    startsAt: new Date(Date.parse(slot.startsAt) + 5 * 60_000).toISOString(),
    endsAt: new Date(Date.parse(slot.startsAt) + 15 * 60_000).toISOString(),
  };
  await replan(uid, REVIEW, slot, 'busy-first');
  const before = await storedPlan(uid);
  assert.ok(before.proposal?.memoryUse, 'fixture: the pending offer has no memory provenance');

  const report = await replanWithWithdrawalAtWrite(uid, REVIEW, inside, 'busy-second');
  assert.equal(report.pipelineResult.policyDecision?.action, 'propose_for_review');
  const after = await storedPlan(uid);
  assert.ok(after.proposal, 'the still-conflicted day has no fresh offer');
  assert.notEqual(after.proposal.proposalId, before.proposal.proposalId, 'the stale pending solve was reused');
  assert.equal(after.proposal.memoryUse, undefined, 'the replacement offer kept stale memory provenance');
});

test('R10-002: auto-apply writes the fresh suppressed solve, not the withdrawn pending solve', async () => {
  const uid = await offModeFocusAccount();
  await makeSuppressedWindowMatchKeptWindow(uid);
  await buildPlan(uid);
  const slot = (await storedPlan(uid)).plan.scheduled[0].interval;
  const inside = {
    startsAt: new Date(Date.parse(slot.startsAt) + 5 * 60_000).toISOString(),
    endsAt: new Date(Date.parse(slot.startsAt) + 15 * 60_000).toISOString(),
  };
  await replan(uid, REVIEW, slot, 'busy-first-auto');
  const before = await storedPlan(uid);
  assert.ok(before.proposal?.memoryUse, 'fixture: the pending offer has no memory provenance');

  const report = await replanWithWithdrawalAtWrite(uid, AUTO_APPLY, inside, 'busy-second-auto');
  assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply');
  const after = await storedPlan(uid);
  assert.ok(after.generation > before.generation, 'the fresh auto-apply was not stored');
  assert.equal(after.memoryUse, undefined, 'the auto-applied generation kept stale memory provenance');
});

test('R11-001: the control-centre disable goes through the fence, so a plan that read the window before it is refused', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const before = await memoryFocusForPlan(uid, NOW(), { storage });
  assert.ok(before, 'fixture: no plan read the kept window');
  await fencedPersonalizationConsentStore({ storage }).write(uid, 'disabled', new Date().toISOString());
  const user = await storage.get(userDoc(uid));
  assert.equal(personalizationPurgeMatches(user, before!.purgeEpoch), false, 'a plan that read the window before the disable could still be written');
  assert.equal(await memoryFocusForPlan(uid, NOW(), { storage }), null);
  // And the legacy route wires that store, not the raw one.
  const route = readFileSync(new URL('../../src/app/api/personalization/route.ts', import.meta.url), 'utf8');
  assert.match(route, /consent: fencedPersonalizationConsentStore\(\)/);
  assert.doesNotMatch(route, /createStoragePersonalizationConsentStore/);
});

test('R11-002: an ordinary accept of a plan shaped by since-withdrawn memory answers 409 plan_changed and accepts nothing', async () => {
  const uid = await keptFocusPlan();
  const before = await storedPlan(uid);
  assert.ok(before.memoryUse || before.focusFromMemory === true, 'fixture: the plan used no memory');
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  const accepted = await call(uid, 'plans/[date]/actions', 'POST', { params: { date: TODAY }, body: { action: 'accept' } });
  assert.equal(accepted.status, 409, show(accepted.body));
  assert.equal(accepted.body.reason, 'plan_changed');
  assert.equal((await storedPlan(uid)).status, before.status, 'the withdrawn plan was accepted');
});

test('R12-001: the control-centre delete, through the fenced consent store, answers its receipt and leaves consent at the default', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const fenceBefore = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  const post = (body: Record<string, unknown>) => personalizationControlsPost(new Request('http://localhost/api/personalization', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  assert.equal((await post({ scopeId: uid, now: new Date().toISOString(), action: 'enable' })).status, 200);
  const deleted = await post({ scopeId: uid, now: new Date().toISOString(), action: 'delete' });
  const body = await deleted.json() as any;
  assert.equal(deleted.status, 200, JSON.stringify(body));
  assert.equal(body.kind, 'deleted');
  const consent = await createStoragePersonalizationConsentStore(storage).read(uid);
  assert.deepEqual([consent.state, consent.changedAt], ['disabled', null], 'the consent record survived the delete');
  const fenceAfter = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  assert.ok(fenceAfter > fenceBefore, 'the deletion did not move the personalization fence');
});

test('R13-001: after a withdrawal and a quick re-grant, an untouched memory plan is re-solved under the new fence and can be accepted', async () => {
  const uid = await keptFocusPlan();
  const before = await storedPlan(uid);
  const solvedAt = before.memoryUse?.epoch ?? before.personalizationPurgeEpoch;
  assert.notEqual(solvedAt, undefined, 'fixture: the plan records no solve epoch');
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  await grantPersonalization(uid);
  await getPlan(uid);
  const after = await storedPlan(uid);
  assert.notEqual(after.memoryUse?.epoch ?? after.personalizationPurgeEpoch, solvedAt, 'the stale plan was offered again');
  const accepted = await call(uid, 'plans/[date]/actions', 'POST', { params: { date: TODAY }, body: { action: 'accept' } });
  assert.equal(accepted.status, 200, show(accepted.body));
});

test('R13-001: a touched memory plan after a withdrawal and re-grant shows no basis and says it changed', async () => {
  const uid = await keptFocusPlan();
  await touchPlan(uid);
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  await grantPersonalization(uid);
  const read = await getPlan(uid);
  assert.equal(read.plan.memoryBasis ?? null, null, show(read.plan.memoryBasis));
  assert.equal(read.plan.memoryBasisChanged, true);
});

test('R13-001: off mode too — after a withdrawal and a re-grant, an untouched memory plan is re-solved and can be accepted', async () => {
  const uid = await offModeFocusAccount();
  await buildPlan(uid);
  const before = await storedPlan(uid);
  assert.ok(before.memoryUse, 'fixture: the off-mode plan records no memory use');
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  await grantPersonalization(uid);
  await getPlan(uid);
  const after = await storedPlan(uid);
  assert.notEqual(after.memoryUse?.epoch, before.memoryUse.epoch, 'the stale off-mode plan was offered again');
  const accepted = await call(uid, 'plans/[date]/actions', 'POST', { params: { date: TODAY }, body: { action: 'accept' } });
  assert.equal(accepted.status, 200, show(accepted.body));
});

test('R14-002: a touched off-mode memory plan, after withdraw and re-grant, is accepted under the current fence when it still stands on the allowed window', async () => {
  const uid = await offModeFocusAccount();
  await buildPlan(uid);
  await touchPlan(uid);
  const before = await storedPlan(uid);
  assert.ok(before.memoryUse, 'fixture: the touched plan records no memory use');
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  await grantPersonalization(uid);
  const accepted = await call(uid, 'plans/[date]/actions', 'POST', { params: { date: TODAY }, body: { action: 'accept' } });
  assert.equal(accepted.status, 200, show(accepted.body));
  const after = await storedPlan(uid);
  assert.equal(after.status, 'accepted');
  assert.notEqual(after.memoryUse?.epoch, before.memoryUse.epoch, 'the accepted plan kept the stale fence');
});

test('R14-002: still withdrawn, the touched memory plan is refused (409 plan_changed), never accepted', async () => {
  const uid = await offModeFocusAccount();
  await buildPlan(uid);
  await touchPlan(uid);
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  const accepted = await call(uid, 'plans/[date]/actions', 'POST', { params: { date: TODAY }, body: { action: 'accept' } });
  assert.equal(accepted.status, 409, show(accepted.body));
  assert.notEqual((await storedPlan(uid)).status, 'accepted');
});

test('R16-001: accepting, with a now-stale slot, an action that cites a dismissed outcome leaves it dismissed rather than pending', async () => {
  const uid = await begin();
  await grantRecommendations(uid);
  const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', NOW());
  const citing = await storeSuggestion(uid, 'action', [outcome.id]);
  assert.equal((await call(uid, 'intelligence/observations/[id]', 'POST', { params: { id: outcome.id }, body: { review: 'dismissed' } })).status, 200);
  // The client still shows the suggestion and the slot it offered, which has since passed.
  const slot = { startsAt: new Date(Date.now() - 3_600_000).toISOString(), endsAt: new Date(Date.now() - 1_800_000).toISOString() };
  const result = await call(uid, 'intelligence/suggestions/[id]', 'POST', { params: { id: citing.id }, body: { decision: 'accept', slot } });
  assert.ok(result.status < 500, show(result.body));
  assert.equal((await storedSuggestion(uid, citing.id))?.status, 'dismissed');
});

test('R16-002: a week card shown, then withdraw and re-grant before acceptance, answers week_changed even with the same rows', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const { composeWeek, weekToDto } = await import('../../lib/services/dailyPlan/weekPlan.ts');
  const TOMORROW = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.parse(NOW()) + 86_400_000));
  await addFloating(uid, 'Write the quarterly report', 'cmt-r16-week-task-00000000001');
  const decisions = { moves: [{ itemId: 'cmt-r16-week-task-00000000001', date: TOMORROW }], drops: [] };
  const layout = await composeWeek(uid, decisions as any, { storage, now: () => new Date() } as any);
  const day = (layout.days as any[]).find((candidate) => candidate.date === TOMORROW);
  assert.ok(day && day.kind === 'proposed' && day.focusFromMemory === true, 'fixture: tomorrow is not a memory-shaped proposed day');
  const dtoDay = (weekToDto(layout as any) as any).days.find((candidate: any) => candidate.date === TOMORROW);
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage });
  await grantPersonalization(uid);
  const accepted = await call(uid, 'plans/week/accept', 'POST', { body: { date: TOMORROW, shown: day.assignment.include, ...decisions, layoutDigest: dtoDay.layoutDigest } });
  assert.equal(accepted.status, 409, show(accepted.body));
  assert.equal(accepted.body.reason, 'week_changed');
});

test('R17-001: a second withdrawal waits for one still between its phases and never reopens the fence while consent is on', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  let releaseW1!: () => void;
  const w1Paused = new Promise<void>((resolve) => { releaseW1 = resolve; });
  let w1Entered!: () => void;
  const w1InStore = new Promise<void>((resolve) => { w1Entered = resolve; });
  const pausing = { ...base, read: base.read.bind(base), write: async (...args: Parameters<typeof base.write>) => { w1Entered(); await w1Paused; return base.write(...args); } };
  const failing = { ...base, read: base.read.bind(base), write: async () => { throw new Error('store unavailable'); } };
  const w1 = setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: pausing as any });
  await w1InStore;
  const fenceDuringW1 = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.equal(fenceDuringW1?.state, 'withdrawing');
  // W2 arrives from another device while W1 has not yet disabled consent; its own store write would fail.
  await assert.rejects(
    setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: failing as any, purgeWait: { attempts: 3, delayMs: 1 } }),
    PersonalizationWithdrawalBusyError,
  );
  const fenceAfterW2 = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fenceAfterW2?.state, fenceAfterW2?.epoch], ['withdrawing', fenceDuringW1.epoch], 'W2 reopened the fence while consent was still on');
  assert.equal(await memoryFocusForPlan(uid, NOW(), { storage }), null, 'memory was readable during the first withdrawal');
  releaseW1();
  await w1;
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.epoch], ['active', fenceDuringW1.epoch]);
  assert.equal((await base.read(uid)).state, 'disabled');
});

test('R17-001: a withdrawal left between its phases longer than a stale owner could live is taken over', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  await setFence(storage, uid, { state: 'withdrawing', epoch: 7, consentWithdrawnAt: old } as any);
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, purgeWait: { attempts: 2, delayMs: 1 } });
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.epoch], ['active', 8]);
});

test('R18-001: a takeover of a live-but-slow withdrawal whose own write fails leaves the fence closed while consent is on', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  let releaseW1!: () => void;
  const w1Paused = new Promise<void>((resolve) => { releaseW1 = resolve; });
  let w1Entered!: () => void;
  const w1InStore = new Promise<void>((resolve) => { w1Entered = resolve; });
  const pausing = { ...base, read: base.read.bind(base), write: async (...args: Parameters<typeof base.write>) => { w1Entered(); await w1Paused; return base.write(...args); } };
  const failing = { ...base, read: base.read.bind(base), write: async () => { throw new Error('store unavailable'); } };
  const w1 = setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: pausing as any });
  await w1InStore;
  // W1 is still running but its lease has run out (a slow store): W2 takes over, and its own write fails.
  const fence1 = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  await setFence(storage, uid, { ...fence1, withdrawalLeaseAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  await assert.rejects(setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: failing as any, purgeWait: { attempts: 2, delayMs: 1 } }));
  assert.equal(((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.state, 'withdrawing', 'the failed takeover reopened the fence while consent was on');
  assert.equal(await memoryFocusForPlan(uid, NOW(), { storage }), null, 'memory was readable during the unfinished withdrawal');
  releaseW1();
  // W2 took the fence over, so W1 no longer owns it: its unguarded store write
  // (a store without `writeGuarded`) lands, but its answer is not recorded
  // (R25-002), and it is told to ask again.
  await assert.rejects(w1, PersonalizationWithdrawalBusyError);
  assert.equal((await base.read(uid)).state, 'disabled');
  assert.equal(await memoryFocusForPlan(uid, NOW(), { storage }), null);
  // R19-001: consent is off now, so the fence W2 left behind is recovered, and
  // an immediate grant brings memory back.
  assert.equal(((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.state, 'active', 'the fence stayed stranded after consent was off');
  await grantPersonalization(uid);
  assert.ok(await memoryFocusForPlan(uid, NOW(), { storage }), 'an immediate grant did not bring memory back');
});

test('R19-001: a grant waits while a live withdrawal owns the fence, and is refused if it lasts', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  await setFence(storage, uid, { state: 'withdrawing', epoch: 9, withdrawalOwner: 'live', withdrawalLeaseAt: new Date().toISOString() });
  await assert.rejects(
    setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, purgeWait: { attempts: 2, delayMs: 1 } }),
    PersonalizationWithdrawalBusyError,
  );
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.withdrawalOwner], ['withdrawing', 'live']);
});

test("R18-001: a caller's clock cannot make a live withdrawal look stale", async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  await setFence(storage, uid, { state: 'withdrawing', epoch: 4, withdrawalOwner: 'someone-else', withdrawalLeaseAt: new Date().toISOString(), consentWithdrawnAt: new Date().toISOString() });
  await assert.rejects(
    setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(Date.now() + 24 * 3_600_000) }, { storage, purgeWait: { attempts: 2, delayMs: 1 } }),
    PersonalizationWithdrawalBusyError,
  );
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.epoch, fence?.withdrawalOwner], ['withdrawing', 4, 'someone-else']);
});

test('R18-001: granting again reopens a fence a dead withdrawal left closed', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  await setFence(storage, uid, { state: 'withdrawing', epoch: 5, withdrawalOwner: 'dead', withdrawalLeaseAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  await grantPersonalization(uid);
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.epoch], ['active', 6]);
  assert.ok(await memoryFocusForPlan(uid, NOW(), { storage }), 'memory stayed closed after the grant');
});

test('R18-002: a reused pre-memoryUse (on-mode) pending offer is fenced at the write, so a withdrawal never lets it auto-apply', async () => {
  const uid = await begin();
  await grantPersonalization(uid);
  await threeTasks(uid);
  await storeKeptFocus(uid);
  await makeSuppressedWindowMatchKeptWindow(uid);
  await buildPlan(uid);
  const slot = (await storedPlan(uid)).plan.scheduled[0].interval;
  const inside = {
    startsAt: new Date(Date.parse(slot.startsAt) + 5 * 60_000).toISOString(),
    endsAt: new Date(Date.parse(slot.startsAt) + 15 * 60_000).toISOString(),
  };
  await replan(uid, REVIEW, slot, 'busy-first-legacy');
  const stored = await storedPlan(uid);
  assert.equal(stored.proposal?.focusFromMemory, true, 'fixture: the pending offer did not use memory');
  // As an offer stored before \`memoryUse\` existed.
  const { memoryUse: _use, storedPurgeEpoch: _stored, ...legacy } = stored.proposal;
  await currentStorage().set(planPath(uid, TODAY), { ...stored, proposal: legacy });
  const report = await replanWithWithdrawalAtWrite(uid, AUTO_APPLY, inside, 'busy-second-legacy');
  const after = await storedPlan(uid);
  assert.notEqual(after.focusFromMemory, true, show({ action: report.pipelineResult.policyDecision?.action, focus: after.focusFromMemory }));
});

test('R20-002: a withdrawal that outlives its lease cannot turn off a grant that superseded it', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  let releaseW1!: () => void;
  const w1Paused = new Promise<void>((resolve) => { releaseW1 = resolve; });
  let w1Entered!: () => void;
  const w1InStore = new Promise<void>((resolve) => { w1Entered = resolve; });
  const pausing = {
    read: base.read.bind(base), write: base.write.bind(base), deleteScope: base.deleteScope.bind(base),
    writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => { w1Entered(); await w1Paused; return base.writeGuarded!(...args); },
  };
  const w1 = setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: pausing as any });
  await w1InStore;
  // W1's lease runs out while it is still running; the person grants again.
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  await setFence(storage, uid, { ...fence, withdrawalLeaseAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  await grantPersonalization(uid);
  releaseW1();
  await assert.rejects(w1, PersonalizationWithdrawalBusyError);
  assert.equal((await base.read(uid)).state, 'enabled', 'the stale withdrawal turned the newer grant off');
  assert.equal(((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.state, 'active');
  assert.ok(await memoryFocusForPlan(uid, NOW(), { storage }), 'memory is not back after the grant');
});

test('R21-001: a grant that resumes after a whole withdrawal ran cannot turn that withdrawal back on', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  let releaseGrant!: () => void;
  const grantPaused = new Promise<void>((resolve) => { releaseGrant = resolve; });
  let grantEntered!: () => void;
  const grantInStore = new Promise<void>((resolve) => { grantEntered = resolve; });
  // The grant has passed its fence checks and recorded its answer; it pauses
  // just before enabling the store.
  const pausing = {
    read: base.read.bind(base), write: base.write.bind(base), deleteScope: base.deleteScope.bind(base),
    writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => {
      if (args[1] === 'enabled') { grantEntered(); await grantPaused; }
      return base.writeGuarded!(...args);
    },
  };
  const grant = setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: pausing as any });
  await grantInStore;
  // Another device withdraws, start to finish.
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage });
  releaseGrant();
  await assert.rejects(grant, PersonalizationConsentNotRecordedError);
  assert.equal((await base.read(uid)).state, 'disabled', 'the resumed grant turned the withdrawal back on');
  const { getConsent } = await import('../../lib/consents/consentService.ts');
  const { PERSONALIZATION_CONSENT } = await import('../../src/contracts/v1/consentContracts.ts');
  assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid, { storage }), 'declined');
  assert.equal(await memoryFocusForPlan(uid, NOW(), { storage }), null, 'memory is open after the withdrawal');
});

test('R21-001: a withdrawal records its answer while the fence is still closed', async () => {
  const uid = await keptFocusPlan();
  const real = currentStorage() as any;
  const fenceAtAnswer: unknown[] = [];
  const storage = new Proxy(real, {
    get(target, key) {
      if (key === 'runTransaction') {
        return (fn: (tx: any) => Promise<unknown>) => target.runTransaction((tx: any) => fn(new Proxy(tx, {
          get(t, k) {
            const v = Reflect.get(t, k);
            if (k === 'merge' && typeof v === 'function') {
              return async (path: string, value: any, ...rest: unknown[]) => {
                if (path === userDoc(uid) && value?.consents?.personalization) {
                  fenceAtAnswer.push((await target.get(userDoc(uid)))?.personalizationPurge?.state);
                }
                return v.call(t, path, value, ...rest);
              };
            }
            return typeof v === 'function' ? v.bind(t) : v;
          },
        })));
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage });
  assert.deepEqual(fenceAtAnswer, ['withdrawing'], 'the answer was recorded after the fence reopened');
  assert.equal((await real.get(userDoc(uid)))?.personalizationPurge?.state, 'active');
});

test('R22-001: a grant decided while a withdrawal owns the fence writes nothing until that withdrawal is over', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage });
  const epoch = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch;
  await setFence(storage, uid, { state: 'withdrawing', epoch: epoch + 1, withdrawalOwner: 'live', withdrawalLeaseAt: new Date().toISOString() });
  const grant = setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(Date.now() + 1_000) }, { storage, purgeWait: { attempts: 400, delayMs: 5 } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const { getConsent } = await import('../../lib/consents/consentService.ts');
  const { PERSONALIZATION_CONSENT } = await import('../../src/contracts/v1/consentContracts.ts');
  assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid, { storage }), 'declined', 'the grant was recorded under a live withdrawal');
  assert.equal((await base.read(uid)).state, 'disabled');
  // The withdrawal finishes; the grant, decided after it, then goes through.
  await setFence(storage, uid, { state: 'active', epoch: epoch + 1, withdrawalOwner: null, withdrawalLeaseAt: null });
  await grant;
  assert.equal((await base.read(uid)).state, 'enabled');
  assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid, { storage }), 'granted');
});

test("R22-002: a refused grant's rollback never overwrites a newer grant that succeeded", async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  let releaseG1!: () => void;
  const g1Paused = new Promise<void>((resolve) => { releaseG1 = resolve; });
  let g1Entered!: () => void;
  const g1InStore = new Promise<void>((resolve) => { g1Entered = resolve; });
  const pausing = {
    read: base.read.bind(base), write: base.write.bind(base), deleteScope: base.deleteScope.bind(base),
    writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => {
      if (args[1] === 'enabled') { g1Entered(); await g1Paused; }
      return base.writeGuarded!(...args);
    },
  };
  const g1 = setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: pausing as any });
  await g1InStore;
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(Date.now() + 1_000) }, { storage });
  await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(Date.now() + 2_000) }, { storage });
  releaseG1();
  await assert.rejects(g1, PersonalizationConsentNotRecordedError);
  const { getConsent } = await import('../../lib/consents/consentService.ts');
  const { PERSONALIZATION_CONSENT } = await import('../../src/contracts/v1/consentContracts.ts');
  assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid, { storage }), 'granted', "the stale grant's rollback erased the newer grant");
  assert.equal((await base.read(uid)).state, 'enabled');
});

test("R23-001: a superseded withdrawal never reopens a live takeover's fence between its disable and its answer", async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  const gate = () => { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { open, wait }; };
  const w1Release = gate(); const w1Entered = gate();
  const w1Store = {
    read: base.read.bind(base), write: base.write.bind(base), deleteScope: base.deleteScope.bind(base),
    writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => { w1Entered.open(); await w1Release.wait; return base.writeGuarded!(...args); },
  };
  const w2Release = gate(); const w2Disabled = gate();
  const w2Store = {
    read: base.read.bind(base), write: base.write.bind(base), deleteScope: base.deleteScope.bind(base),
    // W2 disables, then pauses before its declined answer is recorded.
    writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => { const written = await base.writeGuarded!(...args); w2Disabled.open(); await w2Release.wait; return written; },
  };
  const w1 = setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: w1Store as any });
  await w1Entered.wait;
  const fence1 = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  await setFence(storage, uid, { ...fence1, withdrawalLeaseAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  const w2 = setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(Date.now() + 1_000) }, { storage, consent: w2Store as any });
  await w2Disabled.wait;
  const w2Fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  w1Release.open();
  await assert.rejects(w1, PersonalizationWithdrawalBusyError);
  const afterW1 = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([afterW1?.state, afterW1?.withdrawalOwner], ['withdrawing', w2Fence.withdrawalOwner], "W1 reopened W2's live fence");
  await assert.rejects(
    setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(Date.now() + 2_000) }, { storage, purgeWait: { attempts: 2, delayMs: 1 } }),
    PersonalizationWithdrawalBusyError,
  );
  w2Release.open();
  await w2;
  const { getConsent } = await import('../../lib/consents/consentService.ts');
  const { PERSONALIZATION_CONSENT } = await import('../../src/contracts/v1/consentContracts.ts');
  assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid, { storage }), 'declined');
  assert.equal(((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.state, 'active');
  await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(Date.now() + 3_000) }, { storage });
  assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid, { storage }), 'granted');
  assert.equal((await base.read(uid)).state, 'enabled');
});

test("R24-001: a refused grant's rollback never overwrites a newer grant even when every public field is identical", async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  let releaseG1!: () => void;
  const g1Paused = new Promise<void>((resolve) => { releaseG1 = resolve; });
  let g1Entered!: () => void;
  const g1InStore = new Promise<void>((resolve) => { g1Entered = resolve; });
  const pausing = {
    read: base.read.bind(base), write: base.write.bind(base), deleteScope: base.deleteScope.bind(base),
    writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => {
      if (args[1] === 'enabled') { g1Entered(); await g1Paused; }
      return base.writeGuarded!(...args);
    },
  };
  const same = new Date(Date.now() + 5_000);
  const g1 = setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: same }, { storage, consent: pausing as any });
  await g1InStore;
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage });
  await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: same }, { storage });
  releaseG1();
  await assert.rejects(g1, PersonalizationConsentNotRecordedError);
  const { getConsent } = await import('../../lib/consents/consentService.ts');
  const { PERSONALIZATION_CONSENT } = await import('../../src/contracts/v1/consentContracts.ts');
  assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid, { storage }), 'granted', "an identical-looking newer grant was rolled back");
  assert.equal((await base.read(uid)).state, 'enabled');
});

test('R24-002: a moved-fence rebase is refused once the routine owns focus time, as a fresh solve would refuse the memory', async () => {
  const uid = await offModeFocusAccount();
  await buildPlan(uid);
  await touchPlan(uid);
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  await grantPersonalization(uid);
  const routine = {
    schemaVersion: 1, updatedAt: NOW(), timezone: TZ, sleepWindow: { start: '23:00', end: '07:00' },
    focusWindows: [{ start: '14:00', end: '17:00', label: 'work_study' }], fixedCommitmentWindows: [],
    preferredReminderIntensity: 'followUp', quietHours: null, surveySkipped: false,
  };
  // Before the read: the rebase is never authorized.
  await setAccount(uid, { profile: { routine } });
  const early = await call(uid, 'plans/[date]/actions', 'POST', { params: { date: TODAY }, body: { action: 'accept' } });
  assert.equal(early.status, 409, show(early.body));
  await setAccount(uid, { profile: { routine: { ...routine, focusWindows: [] } } });
  // Between the read and the transaction: the transaction refuses it.
  const real = currentStorage() as any;
  let routed = false;
  const storage = new Proxy(real, {
    get(target, key) {
      if (key === 'runTransaction') {
        return async (fn: (tx: any) => Promise<unknown>) => {
          if (!routed) {
            routed = true;
            const user = (await target.get(userDoc(uid))) ?? {};
            await target.set(userDoc(uid), { ...user, profile: { ...(user.profile ?? {}), routine } });
          }
          return target.runTransaction(fn);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(acceptPlan(uid, TODAY, { storage } as any), PlanWriteGuardRejected);
  assert.ok(routed, 'fixture: the acceptance never reached its transaction');
  assert.notEqual((await storedPlan(uid)).status, 'accepted');
});

test('R24-003: a kept focus record deleted between the rebase read and the acceptance transaction refuses the acceptance', async () => {
  const uid = await offModeFocusAccount();
  await buildPlan(uid);
  await touchPlan(uid);
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  await grantPersonalization(uid);
  const real = currentStorage() as any;
  const { runtimeMemoryRecordPath } = await import('../../lib/runtimeMemory/runtimeMemoryStore.ts');
  const [kept] = await createStorageRuntimeMemoryStore(undefined, real).retrieve({ scopeId: uid, now: new Date().toISOString() });
  assert.ok(kept, 'fixture: no kept focus record');
  let deleted = false;
  const storage = new Proxy(real, {
    get(target, key) {
      if (key === 'runTransaction') {
        return async (fn: (tx: any) => Promise<unknown>) => {
          // Another device deletes the record after the rebase read.
          if (!deleted) { deleted = true; await target.delete(runtimeMemoryRecordPath(uid, kept!.id)); }
          return target.runTransaction(fn);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(acceptPlan(uid, TODAY, { storage } as any), PlanWriteGuardRejected);
  assert.ok(deleted, 'fixture: the acceptance never reached its transaction');
  assert.notEqual((await storedPlan(uid)).status, 'accepted');
});

test('R25-001: a grant refused for its version never touches the fence of a slow withdrawal', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  await setFence(storage, uid, { state: 'withdrawing', epoch: 12, withdrawalOwner: 'slow', withdrawalLeaseAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  const { UnsupportedConsentVersionError } = await import('../../lib/consents/consentService.ts');
  await assert.rejects(
    setPersonalizationConsent(uid, { state: 'granted', version: 'personalization-v999', at: new Date() }, { storage }),
    UnsupportedConsentVersionError,
  );
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.epoch, fence?.withdrawalOwner], ['withdrawing', 12, 'slow'], 'a refused grant superseded the withdrawal');
});

test("R25-002: a withdrawal that stalls past its lease after disabling never writes its declined over a newer grant", async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let disabled!: () => void;
  const afterDisable = new Promise<void>((resolve) => { disabled = resolve; });
  const stalling = {
    read: base.read.bind(base), write: base.write.bind(base), deleteScope: base.deleteScope.bind(base),
    writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => { const written = await base.writeGuarded!(...args); disabled(); await paused; return written; },
  };
  const w = setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: stalling as any });
  await afterDisable;
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  await setFence(storage, uid, { ...fence, withdrawalLeaseAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(Date.now() + 1_000) }, { storage });
  release();
  await assert.rejects(w, PersonalizationWithdrawalBusyError);
  const { getConsent } = await import('../../lib/consents/consentService.ts');
  const { PERSONALIZATION_CONSENT } = await import('../../src/contracts/v1/consentContracts.ts');
  assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid, { storage }), 'granted', 'the superseded withdrawal wrote its declined answer');
  assert.equal((await base.read(uid)).state, 'enabled');
});

test('R26-001: a delete-all purge never takes the fence from a live withdrawal between its disable and its answer', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let disabled!: () => void;
  const afterDisable = new Promise<void>((resolve) => { disabled = resolve; });
  const stalling = {
    read: base.read.bind(base), write: base.write.bind(base), deleteScope: base.deleteScope.bind(base),
    writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => { const written = await base.writeGuarded!(...args); disabled(); await paused; return written; },
  };
  const w = setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: stalling as any });
  await afterDisable;
  const { deletePersonalizationScope } = await import('../../lib/personalization/deletion.ts');
  const { createStorageFeedbackEventStore } = await import('../../lib/feedback/feedbackEventStore.ts');
  const purgeInput = (wait: { attempts: number; delayMs: number }) => ({
    scopeId: uid, now: new Date().toISOString(), storage,
    feedbackEvents: createStorageFeedbackEventStore(storage),
    runtimeMemory: createStorageRuntimeMemoryStore(undefined, storage),
    withdrawalWait: wait,
  });
  // While the withdrawal is live, the purge waits and then refuses, changing nothing.
  await assert.rejects(deletePersonalizationScope(purgeInput({ attempts: 2, delayMs: 1 }) as any), PersonalizationWithdrawalBusyError);
  assert.equal(((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.state, 'withdrawing', 'the purge took the fence from a live withdrawal');
  // A purge already waiting goes through once the withdrawal finishes.
  const purge = deletePersonalizationScope(purgeInput({ attempts: 400, delayMs: 5 }) as any);
  release();
  await w;
  await purge;
  const { getConsent } = await import('../../lib/consents/consentService.ts');
  const { PERSONALIZATION_CONSENT } = await import('../../src/contracts/v1/consentContracts.ts');
  assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid, { storage }), 'declined');
  assert.equal((await base.read(uid)).state, 'disabled', 'the answer and the store disagree');
});

test('R26-002: an account export carries no consent operation token or withdrawal ownership', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage });
  await setFence(storage, uid, { ...(((await storage.get(userDoc(uid))) ?? {}).personalizationPurge), withdrawalOwner: 'someone', withdrawalLeaseAt: new Date().toISOString(), purgeOwner: 'p9', purgeLeaseAt: new Date().toISOString() });
  assert.ok(((await storage.get(userDoc(uid))) ?? {}).consentOps, 'fixture: no consent operation was stored');
  const { buildAccountExport } = await import('../../lib/account/accountExport.ts');
  const archive = await buildAccountExport(uid, { storage } as any);
  const profile = (archive as any).account.profile;
  assert.equal(profile.consentOps, undefined);
  assert.equal(profile.personalizationPurge?.withdrawalOwner, undefined);
  assert.equal(profile.personalizationPurge?.withdrawalLeaseAt, undefined);
  // R30-003: a purge's ownership is internal too.
  assert.equal(profile.personalizationPurge?.purgeOwner, undefined);
  assert.equal(profile.personalizationPurge?.purgeLeaseAt, undefined);
  assert.ok(profile.consents?.personalization, 'the consent answer itself is still exported');
});

async function purgeFor(uid: string, storage: any, now: string, wait: { attempts: number; delayMs: number }) {
  const { deletePersonalizationScope } = await import('../../lib/personalization/deletion.ts');
  const { createStorageFeedbackEventStore } = await import('../../lib/feedback/feedbackEventStore.ts');
  return deletePersonalizationScope({
    scopeId: uid, now, storage,
    feedbackEvents: createStorageFeedbackEventStore(storage),
    runtimeMemory: createStorageRuntimeMemoryStore(undefined, storage),
    withdrawalWait: wait,
  } as any);
}

test("R27-001: a purge judges a withdrawal's lease on the server's clock, never on a request's future time", async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  await setFence(storage, uid, { state: 'withdrawing', epoch: 30, withdrawalOwner: 'live', withdrawalLeaseAt: new Date().toISOString() });
  const future = new Date(Date.now() + 24 * 3_600_000).toISOString();
  await assert.rejects(purgeFor(uid, storage, future, { attempts: 2, delayMs: 1 }), PersonalizationWithdrawalBusyError);
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.withdrawalOwner], ['withdrawing', 'live'], 'a future request time made a live withdrawal look expired');
});

test('R27-002: a purge that takes over a withdrawal which died after its disable completes it, so consent records agree', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let disabled!: () => void;
  const afterDisable = new Promise<void>((resolve) => { disabled = resolve; });
  const stalling = {
    read: base.read.bind(base), write: base.write.bind(base), deleteScope: base.deleteScope.bind(base),
    writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => { const written = await base.writeGuarded!(...args); disabled(); await paused; return written; },
  };
  const w = setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: stalling as any });
  await afterDisable;
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  await setFence(storage, uid, { ...fence, withdrawalLeaseAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  await purgeFor(uid, storage, new Date().toISOString(), { attempts: 2, delayMs: 1 });
  release();
  await assert.rejects(w, PersonalizationWithdrawalBusyError);
  const { getConsent } = await import('../../lib/consents/consentService.ts');
  const { PERSONALIZATION_CONSENT } = await import('../../src/contracts/v1/consentContracts.ts');
  assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid, { storage }), 'declined', 'the answer was left granted after the purge');
  assert.equal((await base.read(uid)).state, 'disabled');
  assert.equal(((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.state, 'active');
});

test("R27-003: the legacy store's enable goes through the fence: refused while a withdrawal owns it, granted once it is done", async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const base = createStoragePersonalizationConsentStore(storage);
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage });
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  await setFence(storage, uid, { ...fence, state: 'withdrawing', epoch: (fence?.epoch ?? 0) + 1, withdrawalOwner: 'live', withdrawalLeaseAt: new Date().toISOString() });
  const legacy = fencedPersonalizationConsentStore({ storage, purgeWait: { attempts: 2, delayMs: 1 } });
  await assert.rejects(legacy.write(uid, 'enabled', new Date().toISOString()), PersonalizationWithdrawalBusyError);
  assert.equal((await base.read(uid)).state, 'disabled', 'a raw enable landed under a live withdrawal');
  await setFence(storage, uid, { ...fence, state: 'active', epoch: (fence?.epoch ?? 0) + 1, withdrawalOwner: null, withdrawalLeaseAt: null });
  await legacy.write(uid, 'enabled', new Date().toISOString());
  assert.equal((await base.read(uid)).state, 'enabled');
});

test('R28-003: the control-centre delete leaves the versioned answer declined, agreeing with the effective state', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const post = (body: Record<string, unknown>) => personalizationControlsPost(new Request('http://localhost/api/personalization', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const deleted = await post({ scopeId: uid, now: new Date().toISOString(), action: 'delete' });
  assert.equal(deleted.status, 200, JSON.stringify(await deleted.clone().json()));
  const { allConsentsView } = await import('../../lib/consents/consentService.ts');
  const { personalizationGrowthAllowed } = await import('../../lib/consents/personalizationConsentService.ts');
  assert.equal((await allConsentsView(uid, { storage })).personalization.state, 'declined', 'the toggle still reads granted');
  assert.equal(await personalizationGrowthAllowed(uid, { storage }), false);
  assert.equal(((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.state, 'active');
});

test('R28-002: a purge refused behind a live withdrawal runs none of its caller\'s erasures', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  await setFence(storage, uid, { state: 'withdrawing', epoch: 40, withdrawalOwner: 'live', withdrawalLeaseAt: new Date().toISOString() });
  let erased = false;
  const { deletePersonalizationScope } = await import('../../lib/personalization/deletion.ts');
  const { createStorageFeedbackEventStore } = await import('../../lib/feedback/feedbackEventStore.ts');
  await assert.rejects(deletePersonalizationScope({
    scopeId: uid, now: new Date().toISOString(), storage,
    feedbackEvents: createStorageFeedbackEventStore(storage),
    runtimeMemory: createStorageRuntimeMemoryStore(undefined, storage),
    withdrawalWait: { attempts: 2, delayMs: 1 },
    onFenced: async () => { erased = true; },
  } as any), PersonalizationWithdrawalBusyError);
  assert.equal(erased, false, 'the caller erased before the purge held the fence');
  const source = readFileSync(new URL('../../lib/services/mobile/memoryService.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function deleteAllMemory'), source.indexOf('export async function deleteAllMemory') + 2500);
  assert.match(body, /onFenced: \(\) => clearAiContextImportReceipt/, 'delete-all clears the import receipt outside the fence');
  assert.equal(/\n  await clearAiContextImportReceipt\(/.test(body), false, 'delete-all clears the import receipt before the purge');
});

test('R29-001: one purge at a time — a live purge keeps the fence, a dead one is taken over', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  // A live purge (another tap or device) holds the fence: a second waits, then refuses.
  await setFence(storage, uid, { state: 'purging', epoch: 50, startedAt: new Date().toISOString(), purgeOwner: 'p1', purgeLeaseAt: new Date().toISOString() });
  await assert.rejects(purgeFor(uid, storage, new Date().toISOString(), { attempts: 2, delayMs: 1 }), PersonalizationWithdrawalBusyError);
  assert.deepEqual(
    [((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.purgeOwner, ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch],
    ['p1', 50], 'the second purge took a live purge\'s fence',
  );
  // A purge whose lease ran out is taken over; the takeover completes and reopens the fence.
  await setFence(storage, uid, { state: 'purging', epoch: 50, startedAt: new Date(Date.now() - 3_600_000).toISOString(), purgeOwner: 'p1', purgeLeaseAt: new Date(Date.now() - 3_600_000).toISOString() });
  await purgeFor(uid, storage, new Date().toISOString(), { attempts: 2, delayMs: 1 });
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.epoch, fence?.purgeOwner ?? null], ['active', 51, null]);
});

test("R30-004: a purge renews its lease as it works, so a long one is never taken for dead", async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const { deletePersonalizationScope } = await import('../../lib/personalization/deletion.ts');
  const { createStorageFeedbackEventStore } = await import('../../lib/feedback/feedbackEventStore.ts');
  const memory = createStorageRuntimeMemoryStore(undefined, storage);
  let leaseAtMemoryStep: string | undefined;
  await deletePersonalizationScope({
    scopeId: uid, now: new Date().toISOString(), storage,
    feedbackEvents: createStorageFeedbackEventStore(storage),
    runtimeMemory: { ...memory, listAll: memory.listAll.bind(memory), deleteScope: async (scopeId: string) => {
      leaseAtMemoryStep = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.purgeLeaseAt;
      return memory.deleteScope(scopeId);
    } } as any,
    // The purge has been running "for an hour" when its caller's hook runs.
    onFenced: async () => {
      const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
      await setFence(storage, uid, { ...fence, purgeLeaseAt: new Date(Date.now() - 3_600_000).toISOString() });
    },
  } as any);
  assert.ok(leaseAtMemoryStep && Date.now() - Date.parse(leaseAtMemoryStep) < 60_000, `the lease was not renewed: ${leaseAtMemoryStep}`);
});

test('R31-002: a purge whose step fails gives its lease up, so a retry takes over at once', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const { deletePersonalizationScope } = await import('../../lib/personalization/deletion.ts');
  const { createStorageFeedbackEventStore } = await import('../../lib/feedback/feedbackEventStore.ts');
  await assert.rejects(deletePersonalizationScope({
    scopeId: uid, now: new Date().toISOString(), storage,
    feedbackEvents: createStorageFeedbackEventStore(storage),
    runtimeMemory: createStorageRuntimeMemoryStore(undefined, storage),
    onFenced: async () => { throw new Error('transient'); },
  } as any), /transient/);
  assert.equal(((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.state, 'purging', 'the fence opened after a failed purge');
  // An immediate retry is not made to wait behind the dead purge.
  await purgeFor(uid, storage, new Date().toISOString(), { attempts: 2, delayMs: 1 });
  assert.equal(((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.state, 'active');
});

test('R32-002: a long purge step keeps its lease alive, so no successor takes over while it is still erasing', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const { deletePersonalizationScope } = await import('../../lib/personalization/deletion.ts');
  const { createStorageFeedbackEventStore } = await import('../../lib/feedback/feedbackEventStore.ts');
  const memory = createStorageRuntimeMemoryStore(undefined, storage);
  let successor: unknown = 'not tried';
  await deletePersonalizationScope({
    scopeId: uid, now: new Date().toISOString(), storage, heartbeatMs: 5,
    feedbackEvents: createStorageFeedbackEventStore(storage),
    runtimeMemory: { ...memory, listAll: memory.listAll.bind(memory), deleteScope: async (scopeId: string) => {
      // The sweep "has run for an hour": its lease looks stale…
      const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
      await setFence(storage, uid, { ...fence, purgeLeaseAt: new Date(Date.now() - 3_600_000).toISOString() });
      // …but it is still working, and its heartbeat renews the lease.
      await new Promise((resolve) => setTimeout(resolve, 40));
      successor = await purgeFor(uid, storage, new Date().toISOString(), { attempts: 1, delayMs: 1 }).then(() => 'took over', (error) => error);
      return memory.deleteScope(scopeId);
    } } as any,
  } as any);
  assert.ok(successor instanceof PersonalizationWithdrawalBusyError, `a successor took over a purge still erasing: ${String(successor)}`);
});

test('R32-003: the purge keeps the fence closed while its caller verifies, and manual memory writes are refused meanwhile', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const { createManualMemory } = await import('../../lib/services/mobile/memoryService.ts');
  const { MemoryWriteRefusedError } = await import('../../lib/runtimeMemory/runtimeMemoryStore.ts');
  let stateDuringVerify: unknown;
  let refused: unknown;
  const { deletePersonalizationScope } = await import('../../lib/personalization/deletion.ts');
  const { createStorageFeedbackEventStore } = await import('../../lib/feedback/feedbackEventStore.ts');
  await deletePersonalizationScope({
    scopeId: uid, now: new Date().toISOString(), storage,
    feedbackEvents: createStorageFeedbackEventStore(storage),
    runtimeMemory: createStorageRuntimeMemoryStore(undefined, storage),
    beforeReopen: async () => {
      stateDuringVerify = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.state;
      refused = await createManualMemory(uid, { kind: 'fact', content: 'I cook on Fridays', language: 'en' } as any, new Date().toISOString(), { storage } as any)
        .then(() => 'written', (error) => error);
    },
  } as any);
  assert.equal(stateDuringVerify, 'purging', 'the fence reopened before the caller verified');
  assert.ok(refused instanceof MemoryWriteRefusedError, `a manual memory was written during the purge: ${String(refused)}`);
  assert.equal((await createStorageRuntimeMemoryStore(undefined, storage).listAll(uid)).length, 0);
});

test('R33-001: an AI import that spans a purge is refused, and delete-all counts a surviving import as incomplete', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const { importAiContext, PersonalizationBusyError } = await import('../../lib/services/mobile/aiContextImportService.ts');
  // The purge begins while the import is waiting on its model.
  let purgeStarted = false;
  const outcome = await importAiContext(uid, 'I work best in the morning.', 'chatgpt' as any, new Date(), {
    storage,
    generate: async () => {
      const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
      await setFence(storage, uid, { ...fence, state: 'purging', epoch: (fence?.epoch ?? 0) + 1, purgeOwner: 'p', purgeLeaseAt: new Date().toISOString() });
      purgeStarted = true;
      return { text: JSON.stringify({ candidates: [] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  } as any).then((r) => ['resolved', r], (e) => ['threw', String(e)]);
  assert.deepEqual(outcome, ['threw', String(new PersonalizationBusyError())], 'an import was saved across the purge');
  assert.ok(purgeStarted, 'fixture: the import never reached its model');
  assert.equal((await storage.list(`users/${uid}/aiContextImports`)).length, 0, 'an import was saved across the purge');
  const source = readFileSync(new URL('../../lib/services/mobile/memoryService.ts', import.meta.url), 'utf8');
  assert.match(source, /\+ receipt\.remainingAiContextImportCount/, 'delete-all ignores a surviving AI import');
});

test('R20-004: a fresh run never answers a suggestion whose outcome was dismissed right after the commit', async () => {
  const uid = await begin();
  await grantRecommendations(uid);
  const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', NOW());
  const real = currentStorage() as any;
  const { proposeFromObservations, intelligenceRunPath } = await import('../../lib/intelligence/proposalEngine.ts');
  const { observationPath } = await import('../../lib/intelligence/observationStore.ts');
  let dismissedAfterCommit = false;
  const storage = new Proxy(real, {
    get(target, key) {
      if (key === 'runTransaction') {
        return async (fn: (tx: any) => Promise<unknown>) => {
          let completesRun = false;
          const result = await target.runTransaction((tx: any) => fn(new Proxy(tx, {
            get(t, k) {
              const v = Reflect.get(t, k);
              if (k === 'set' && typeof v === 'function') {
                return (path: string, value: any, ...rest: unknown[]) => {
                  if (path === intelligenceRunPath(uid) && value?.status === 'complete') completesRun = true;
                  return v.call(t, path, value, ...rest);
                };
              }
              return typeof v === 'function' ? v.bind(t) : v;
            },
          })));
          if (completesRun && !dismissedAfterCommit) {
            dismissedAfterCommit = true;
            const stored = await target.get(observationPath(uid, outcome.id));
            await target.set(observationPath(uid, outcome.id), { ...stored, review: 'dismissed', reviewedAt: new Date().toISOString() });
          }
          return result;
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const suggestions = await proposeFromObservations(uid, new Date().toISOString(), { storage, generate: async () => ({
    text: JSON.stringify({ suggestions: [
      { kind: 'action', title: 'Call the dentist again soon', reason: 'Because you did it', observationIds: [outcome.id], confidence: 0.8, durationMinutes: 30 },
    ] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1,
  }) } as any);
  assert.ok(dismissedAfterCommit, 'fixture: the run never completed');
  assert.equal(suggestions.length, 0, 'a suggestion citing the just-dismissed outcome was answered');
});

test('R20-003: a week plan another device touched between the store and a refused accept is kept, not deleted', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const { composeWeek, acceptWeekDay } = await import('../../lib/services/dailyPlan/weekPlan.ts');
  const TOMORROW = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.parse(NOW()) + 86_400_000));
  await addFloating(uid, 'Write the quarterly report', 'cmt-r20-week-task-00000000001');
  const decisions = { moves: [{ itemId: 'cmt-r20-week-task-00000000001', date: TOMORROW }], drops: [] };
  const layout = await composeWeek(uid, decisions as any, { storage, now: () => new Date() } as any);
  const day = (layout.days as any[]).find((candidate) => candidate.date === TOMORROW);
  assert.ok(day && day.kind === 'proposed', 'fixture: tomorrow is not a proposed day');
  let fired = false;
  const proxied = new Proxy(storage, {
    get(target, key) {
      if (key === 'runTransaction') {
        return async (fn: (tx: any) => Promise<unknown>) => {
          let createsPlan = false;
          const result = await target.runTransaction((tx: any) => fn(new Proxy(tx, {
            get(t, k) {
              const v = Reflect.get(t, k);
              if ((k === 'set' || k === 'create') && typeof v === 'function') {
                return (path: string, ...rest: unknown[]) => { if (path === planPath(uid, TOMORROW)) createsPlan = true; return v.call(t, path, ...rest); };
              }
              return typeof v === 'function' ? v.bind(t) : v;
            },
          })));
          if (createsPlan && !fired) {
            fired = true;
            // Another device touches the plan, then personalization is withdrawn and re-granted.
            const stored = await target.get(planPath(uid, TOMORROW));
            await target.set(planPath(uid, TOMORROW), { ...stored, updatedAt: new Date(Date.now() + 1000).toISOString(), protections: [{ touchedBy: 'other-device' }] });
            await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: target });
            await grantPersonalization(uid);
          }
          return result;
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const outcome = await acceptWeekDay(uid, TOMORROW, decisions as any, day.assignment.include, { storage: proxied, now: () => new Date() } as any, undefined);
  assert.ok(fired, 'fixture: the plan was never stored');
  assert.notEqual(outcome.outcome, 'accepted');
  assert.notEqual(await storage.get(planPath(uid, TOMORROW)), null, "another device's change was deleted");
});
