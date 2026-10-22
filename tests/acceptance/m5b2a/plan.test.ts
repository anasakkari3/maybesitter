/**
 * M5b-2a Gate B, R2: the plan says when memory shaped it, and lets you
 * correct it (condition 35, plan half). PLAN-M5b-2a R2 + Wire. See support.ts
 * for the harness and the gate rules.
 *
 * The kept focus window is an R1 behaviour-rule record (`R1_focus_window:…`),
 * the only memory the planner uses. The plan DTO carries `memoryBasis` and
 * `memoryBasisChanged` next to M5b-1's `basisChanged`; the stored plan carries
 * the `focusFromMemory` marker. Neither names memory content.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageRuntimeMemoryStore } from '../../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { composeDailyPlan } from '../../../lib/services/dailyPlan/dailyPlanService.ts';
import { composeWeek, weekToDto } from '../../../lib/services/dailyPlan/weekPlan.ts';
import { planPath } from '../../../lib/services/dailyPlan/planStore.ts';
import { deleteMemory, patchMemory } from '../../../lib/services/mobile/memoryService.ts';
import { userDoc } from '../../../lib/storage/paths.ts';
import {
  AUTO_APPLY, NOW, REFERENCE, REVIEW, TODAY, TOMORROW, TZ, acceptPlanRoute, addCommitment, addFloating, at, begin, buildPlan,
  call, currentStorage, end, getPlan, grantPersonalization, planAction, replan, setAccount, show, storedPlan, threeTasks,
  touchPlan, type M5bSwitches,
} from './support.ts';

test.afterEach(() => end());

const FOCUS = { start: '09:00', end: '12:00' };
const FINGERPRINT = 'R1_focus_window:09:00-12:00';

/** The person kept the R1 focus window (an unedited behaviour-rule record). */
async function keepFocus(uid: string, fingerprint = FINGERPRINT): Promise<string> {
  const record = await createStorageRuntimeMemoryStore(undefined, currentStorage() as any).put({
    scopeId: uid,
    kind: 'preference',
    content: 'You often finish things between 09:00 and 12:00.',
    language: 'en',
    source: 'deterministic_rule',
    confidence: 0.7,
    observedAt: NOW(),
    evidenceIds: ['ev1', 'ev2'],
    provenance: { origin: 'behaviour_rule', originRef: fingerprint, confirmedByUserAt: NOW() },
  } as any, NOW());
  return (record as any).id;
}

async function account(switches: M5bSwitches = {}, options: { focus?: boolean; consent?: boolean } = {}): Promise<{ uid: string; memoryId: string | null }> {
  const uid = await begin(switches);
  if (options.consent ?? true) await grantPersonalization(uid);
  await threeTasks(uid);
  const memoryId = (options.focus ?? true) ? await keepFocus(uid) : null;
  return { uid, memoryId };
}

function windowsOf(stored: any): number[][] {
  return (stored.constraints.workingWindows as Array<{ startMinute: number; endMinute: number }>).map((w) => [w.startMinute, w.endMinute]);
}

function hasNoMemoryFields(plan: any, label: string): void {
  assert.equal('memoryBasis' in plan, false, `${label}: memoryBasis present`);
  assert.equal('memoryBasisChanged' in plan, false, `${label}: memoryBasisChanged present`);
}

async function startPurge(uid: string): Promise<void> {
  const user = (await currentStorage().get<Record<string, any>>(userDoc(uid))) ?? {};
  const epoch = (user.personalizationPurge?.epoch ?? 0) + 1;
  await setAccount(uid, { personalizationPurge: { state: 'purging', epoch, startedAt: NOW() } });
}

async function finishPurge(uid: string): Promise<void> {
  const user = (await currentStorage().get<Record<string, any>>(userDoc(uid))) ?? {};
  await setAccount(uid, { personalizationPurge: { ...user.personalizationPurge, state: 'active', completedAt: NOW() } });
}

/* ── off and killed: byte parity ───────────────────────────────────── */

for (const [name, switches] of [['off', { on: false }], ['killed', { killed: true }]] as const) {
  test(`R2 parity: ${name}, build and GET carry no memory fields and the stored plan no marker; the kept window still shapes the plan as today`, async () => {
    const { uid } = await account(switches);
    const built = await buildPlan(uid);
    hasNoMemoryFields(built, 'build');
    hasNoMemoryFields((await getPlan(uid)).plan, 'GET');
    const stored = await storedPlan(uid);
    assert.equal('focusFromMemory' in stored, false, 'off-mode writer stored a marker');
    assert.deepEqual(windowsOf(stored), [[540, 720]], 'off mode must keep today\'s keptFocusWindow behaviour');
  });
}

/* ── on_basis ──────────────────────────────────────────────────────── */

test('R2 on: a plan solved inside the kept window stores focusFromMemory true; the DTO names the record and window, and no content', async () => {
  const { uid, memoryId } = await account();
  const built = await buildPlan(uid);
  assert.deepEqual(built.memoryBasis, { memoryId, window: FOCUS }, show(built.memoryBasis));
  assert.equal(built.memoryBasisChanged, false);
  const stored = await storedPlan(uid);
  assert.equal(stored.focusFromMemory, true);
  assert.deepEqual(windowsOf(stored), [[540, 720]]);
  const text = JSON.stringify(stored);
  assert.equal(text.includes(memoryId!), false, 'the stored plan names the memory id');
  assert.equal(text.includes('You often finish things'), false, 'the stored plan carries memory content');
  const read = (await getPlan(uid)).plan;
  assert.deepEqual(read.memoryBasis, { memoryId, window: FOCUS });
  assert.equal(JSON.stringify(read).includes('You often finish things'), false, 'the DTO carries memory content');
});

test('R2 on: no kept window gives focusFromMemory false and memoryBasis null', async () => {
  const { uid } = await account({}, { focus: false });
  const built = await buildPlan(uid);
  assert.equal(built.memoryBasis, null);
  assert.equal(built.memoryBasisChanged, false);
  assert.equal((await storedPlan(uid)).focusFromMemory, false);
});

test('R2 on: a routine that names a focus window takes precedence; the kept window is not used and is not claimed', async () => {
  const { uid } = await account();
  await setAccount(uid, { profile: { routine: {
    schemaVersion: 1, updatedAt: REFERENCE, timezone: TZ, sleepWindow: { start: '23:00', end: '07:00' },
    focusWindows: [{ start: '13:00', end: '17:00', label: 'work_study' }], fixedCommitmentWindows: [],
    preferredReminderIntensity: 'followUp', quietHours: null, surveySkipped: false,
  } } });
  const built = await buildPlan(uid);
  assert.equal(built.memoryBasis, null, show(built.memoryBasis));
  const stored = await storedPlan(uid);
  assert.equal(stored.focusFromMemory, false);
  assert.notDeepEqual(windowsOf(stored), [[540, 720]], 'fixture: the routine did not take precedence');
});

test('R2 on: without personalization consent the window is not used and not claimed', async () => {
  const { uid } = await account({}, { consent: false });
  const built = await buildPlan(uid);
  assert.equal(built.memoryBasis, null);
  assert.equal((await storedPlan(uid)).focusFromMemory, false);
});

/* ── on_nobasis: memory the person cannot open shapes nothing ──────── */

test('R2 on_nobasis: with the memory module off, a kept window does not shape the plan, and no basis is shown', async () => {
  const { uid } = await account({ memory: false });
  const built = await buildPlan(uid);
  assert.equal('memoryBasis' in built, false, 'on_nobasis: memoryBasis present');
  const stored = await storedPlan(uid);
  assert.notDeepEqual(windowsOf(stored), [[540, 720]], 'the kept window shaped the plan while memory was off');
  assert.equal(stored.focusFromMemory ?? false, false);
});

/* ── the basis is live ─────────────────────────────────────────────── */

test('R2 on: deleting the kept record refreshes an untouched plan without the window', async () => {
  const { uid, memoryId } = await account();
  await buildPlan(uid);
  await deleteMemory(uid, memoryId!, NOW(), { storage: currentStorage() as any } as any);
  const read = (await getPlan(uid)).plan;
  assert.equal(read.memoryBasis, null);
  assert.equal(read.memoryBasisChanged, false, 'an untouched plan is refreshed, not flagged');
  const stored = await storedPlan(uid);
  assert.equal(stored.focusFromMemory, false);
  assert.notDeepEqual(windowsOf(stored), [[540, 720]]);
});

test('R2 on: deleting or editing the kept record flags a touched or accepted plan, and never names it', async () => {
  for (const [label, change] of [
    ['delete', (uid: string, id: string) => deleteMemory(uid, id, NOW(), { storage: currentStorage() as any } as any)],
    ['edit', (uid: string, id: string) => patchMemory(uid, id, 'Mornings are when I write.', NOW(), { storage: currentStorage() as any } as any)],
  ] as const) {
    for (const [how, touch] of [['touched', touchPlan], ['accepted', acceptPlanRoute]] as const) {
      const { uid, memoryId } = await account();
      await buildPlan(uid);
      await touch(uid);
      await change(uid, memoryId!);
      const read = (await getPlan(uid)).plan;
      assert.equal(read.memoryBasisChanged, true, `${label}/${how}: not flagged`);
      assert.equal(read.memoryBasis, null, `${label}/${how}: a gone basis is still named`);
      assert.equal(read.basisChanged, false, `${label}/${how}: M5b-1's readiness flag was reused`);
      end();
    }
  }
});

test('R2 on: turning the memory module off makes a touched memory-shaped plan say it changed, with no basis', async () => {
  const { uid } = await account();
  await buildPlan(uid);
  await touchPlan(uid);
  const { setM5bSwitches } = await import('./support.ts');
  setM5bSwitches({ memory: false });
  const read = (await getPlan(uid)).plan;
  assert.equal('memoryBasis' in read, false);
  assert.equal(read.memoryBasisChanged, true);
});

/* ── every full-plan route ─────────────────────────────────────────── */

test('R2 on: the build, actions and regenerate responses carry the same basis as GET', async () => {
  const { uid, memoryId } = await account();
  const built = await buildPlan(uid);
  assert.deepEqual(built.memoryBasis, { memoryId, window: FOCUS }, 'build');
  const stored = await storedPlan(uid);
  const last = stored.plan.scheduled[stored.plan.scheduled.length - 1];
  const edited = await planAction(uid, { action: 'edit', removals: [last.itemId] });
  assert.equal(edited.status, 200, show(edited.body));
  assert.deepEqual(edited.body.plan.memoryBasis, { memoryId, window: FOCUS }, 'actions');
  const regenerated = await call(uid, 'plans/[date]/regenerate', 'POST', { params: { date: TODAY } });
  assert.equal(regenerated.status, 200, show(regenerated.body));
  assert.deepEqual(regenerated.body.plan.memoryBasis, { memoryId, window: FOCUS }, 'regenerate');
});

for (const [name, switches] of [['off', { on: false }], ['killed', { killed: true }]] as const) {
  test(`R2 parity: ${name}, actions and regenerate responses carry no memory fields`, async () => {
    const { uid } = await account(switches);
    await buildPlan(uid);
    const stored = await storedPlan(uid);
    const last = stored.plan.scheduled[stored.plan.scheduled.length - 1];
    const edited = await planAction(uid, { action: 'edit', removals: [last.itemId] });
    assert.equal(edited.status, 200, show(edited.body));
    hasNoMemoryFields(edited.body.plan, 'actions');
    const regenerated = await call(uid, 'plans/[date]/regenerate', 'POST', { params: { date: TODAY } });
    assert.equal(regenerated.status, 200, show(regenerated.body));
    hasNoMemoryFields(regenerated.body.plan, 'regenerate');
  });
}

/* ── the purge fence ───────────────────────────────────────────────── */

test('R2 on: while a purge is running the window is not used, the marker is false, and no basis is shown', async () => {
  const { uid } = await account();
  await startPurge(uid);
  const built = await buildPlan(uid);
  assert.equal(built.memoryBasis, null);
  const stored = await storedPlan(uid);
  assert.equal(stored.focusFromMemory, false);
  assert.notDeepEqual(windowsOf(stored), [[540, 720]]);
});

test('R2 on: a purge that starts between the memory read and the plan write leaves no true marker (one retry, memory suppressed)', async () => {
  const { uid } = await account();
  let fired = false;
  const stored = await composeDailyPlan(uid, TODAY, { timezone: TZ }, 1, {
    storage: currentStorage() as any,
    now: () => new Date(),
    busyBlocks: async () => {
      if (!fired) { fired = true; await startPurge(uid); }
      return [];
    },
  } as any);
  assert.ok(fired, 'fixture: the busy read never ran');
  assert.equal((stored as any).focusFromMemory, false, show((stored as any).focusFromMemory));
  assert.notDeepEqual(windowsOf(stored), [[540, 720]], 'the plan written after the purge began is shaped by the deleted window');
});

test('R2 on: a basis is never shown while a purge is running, even for a plan made before it', async () => {
  const { uid, memoryId } = await account();
  await buildPlan(uid);
  await touchPlan(uid);
  assert.deepEqual((await getPlan(uid)).plan.memoryBasis, { memoryId, window: FOCUS }, 'fixture: no basis before the purge');
  await startPurge(uid);
  assert.equal((await getPlan(uid)).plan.memoryBasis ?? null, null);
});

test('R2 on: after a purge, an untouched memory-shaped plan is rebuilt and a touched one says it changed', async () => {
  for (const touched of [false, true]) {
    const { uid, memoryId } = await account();
    await buildPlan(uid);
    if (touched) await touchPlan(uid);
    await startPurge(uid);
    await deleteMemory(uid, memoryId!, NOW(), { storage: currentStorage() as any } as any);
    await finishPurge(uid);
    const read = (await getPlan(uid)).plan;
    assert.equal(read.memoryBasis, null);
    if (touched) assert.equal(read.memoryBasisChanged, true, 'touched: not flagged');
    else assert.equal((await storedPlan(uid)).focusFromMemory, false, 'untouched: not rebuilt');
    end();
  }
});

/* ── plans from before this slice ──────────────────────────────────── */

async function stripMarker(uid: string, date: string): Promise<void> {
  const stored = await storedPlan(uid, date);
  const { focusFromMemory: _f, ...rest } = stored as Record<string, any>;
  await currentStorage().set(planPath(uid, date), rest);
}

test('R2 on: an untouched plan with no marker is refreshed once, which sets it', async () => {
  const { uid, memoryId } = await account();
  await buildPlan(uid);
  await stripMarker(uid, TODAY);
  const read = (await getPlan(uid)).plan;
  assert.equal((await storedPlan(uid)).focusFromMemory, true, 'no refresh set the marker');
  assert.deepEqual(read.memoryBasis, { memoryId, window: FOCUS });
});

test('R2 on: an accepted plan with no marker, today or at today+6, shows no basis and no notice', async () => {
  const { uid } = await account();
  await buildPlan(uid);
  await acceptPlanRoute(uid);
  await stripMarker(uid, TODAY);
  const read = (await getPlan(uid)).plan;
  assert.equal(read.memoryBasis, null);
  assert.equal(read.memoryBasisChanged, false);
  const SIXTH = new Date(Date.parse(`${TODAY}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  await buildPlan(uid, SIXTH);
  await acceptPlanRoute(uid, SIXTH);
  await stripMarker(uid, SIXTH);
  const later = (await getPlan(uid, SIXTH)).plan;
  assert.equal(later.memoryBasis, null);
  assert.equal(later.memoryBasisChanged, false);
});

/* ── week acceptance ───────────────────────────────────────────────── */

const WEEK_TASK = 'cmt-m5b2a-week-task-000000000001';
const DECISIONS = { moves: [{ itemId: WEEK_TASK, date: TOMORROW }], drops: [] };

async function weekAccount(): Promise<{ uid: string; body: Record<string, unknown> }> {
  const uid = await begin();
  await grantPersonalization(uid);
  await addFloating(uid, 'Write the quarterly report', WEEK_TASK);
  await addCommitment(uid, 'Doctor appointment', { kind: 'scheduled_event', dueAt: at(TOMORROW, '15:00'), endAt: at(TOMORROW, '16:00'), allDay: false });
  await keepFocus(uid);
  const layout = await composeWeek(uid, DECISIONS as any, { storage: currentStorage(), now: () => new Date() } as any);
  const day = (layout.days as any[]).find((candidate) => candidate.date === TOMORROW);
  assert.ok(day && day.kind === 'proposed', 'fixture: tomorrow is not a proposed day');
  const dtoDay = (weekToDto(layout as any) as any).days.find((candidate: any) => candidate.date === TOMORROW);
  return { uid, body: { date: TOMORROW, shown: day.assignment.include, ...DECISIONS, layoutDigest: dtoDay.layoutDigest } };
}

test('R2 on: a week-accepted day stores the marker from its reviewed solve', async () => {
  const { uid, body } = await weekAccount();
  const accepted = await call(uid, 'plans/week/accept', 'POST', { body });
  assert.equal(accepted.status, 200, show(accepted.body));
  assert.equal((await storedPlan(uid, TOMORROW)).focusFromMemory, true);
  assert.ok(accepted.body.plan === undefined || 'memoryBasis' in accepted.body.plan, 'week accept returned a full plan without the basis');
});

test('R2 on: a purge between the week layout and its acceptance answers week_changed and stores nothing', async () => {
  const { uid, body } = await weekAccount();
  await startPurge(uid);
  const accepted = await call(uid, 'plans/week/accept', 'POST', { body });
  assert.equal(accepted.status, 409, show(accepted.body));
  assert.equal(accepted.body.reason, 'week_changed');
  assert.equal(await currentStorage().get(planPath(uid, TOMORROW)), null);
});

/* ── replan offers and auto-apply ──────────────────────────────────── */

test('R2 on: a replan auto-apply that solved inside the window stores the marker', async () => {
  const { uid } = await account();
  await buildPlan(uid);
  const report = await replan(uid, AUTO_APPLY);
  assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply', 'fixture: not auto-applied');
  assert.equal((await storedPlan(uid)).focusFromMemory, true);
});

test('R2 on: an accepted offer installs its solve-time marker, even after the kept record changed', async () => {
  const { uid, memoryId } = await account();
  await buildPlan(uid);
  await replan(uid, REVIEW);
  const proposalId = (await storedPlan(uid)).proposal?.proposalId;
  assert.ok(proposalId, 'fixture: no offer');
  await patchMemory(uid, memoryId!, 'Mornings are when I write.', NOW(), { storage: currentStorage() as any } as any);
  const accepted = await planAction(uid, { action: 'accept_proposal', proposalId });
  assert.equal(accepted.status, 200, show(accepted.body));
  assert.equal((await storedPlan(uid)).focusFromMemory, true, 'the marker was recomputed at acceptance');
  assert.equal((await getPlan(uid)).plan.memoryBasisChanged, true);
});

test('R2 on: an offer made, then a purge, then acceptance: stale_proposal, and nothing shaped by the deleted memory is installed', async () => {
  const { uid } = await account();
  await buildPlan(uid);
  await replan(uid, REVIEW);
  const before = await storedPlan(uid);
  assert.ok(before.proposal?.proposalId, 'fixture: no offer');
  await startPurge(uid);
  const accepted = await planAction(uid, { action: 'accept_proposal', proposalId: before.proposal.proposalId });
  assert.equal(accepted.status, 409, show(accepted.body));
  assert.equal(accepted.body.reason, 'stale_proposal');
  assert.equal((await storedPlan(uid)).generation, before.generation, 'a plan was installed');
});

test('R2 on: an on-mode offer accepted while M5b is off keeps its marker in storage, shows nothing, and is projected again once on', async () => {
  const { uid, memoryId } = await account();
  await buildPlan(uid);
  await replan(uid, REVIEW);
  const proposalId = (await storedPlan(uid)).proposal?.proposalId;
  assert.ok(proposalId, 'fixture: no offer');
  const { setM5bSwitches } = await import('./support.ts');
  setM5bSwitches({ on: false });
  const accepted = await planAction(uid, { action: 'accept_proposal', proposalId });
  assert.equal(accepted.status, 200, show(accepted.body));
  hasNoMemoryFields(accepted.body.plan ?? {}, 'off accept');
  assert.equal((await storedPlan(uid)).focusFromMemory, true);
  setM5bSwitches({});
  assert.deepEqual((await getPlan(uid)).plan.memoryBasis, { memoryId, window: FOCUS });
});

