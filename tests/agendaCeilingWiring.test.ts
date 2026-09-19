/**
 * The server reads the ceiling the user stored (UC-3.13, #199; closes #446).
 *
 * #430 stores the ceiling as `users/{uid}.reminderSettings.escalationCeiling`
 * and #444 enforces it on the phone, but nothing on the server read it:
 * `agendaService` accepted a ceiling only as an option and no caller passed
 * one, so every server-side `pressure_due` ran at the default `soft` ceiling
 * whatever the account held.
 *
 * These tests go through the real route — `GET /api/agenda?userId=…` — with
 * the ceiling stored in the real storage adapter, because the defect was in
 * the wiring, not the clamp. The clamp itself (`intensity = min(base,
 * classification cap, ceiling)`, and a firm tone only at the hard ceiling on a
 * high-priority commitment) is already proven at every ceiling in
 * `tests/safety/avoidanceNeverEscalates.test.ts`; what was missing is the read.
 *
 * ── Mutant guard ──────────────────────────────────────────────────
 *
 * Dropping the read — the route passing no `escalationCeiling`, or
 * `storedCeilingFor` returning `undefined` unconditionally — turns the first
 * test red: at the default ceiling the firm tone and the high intensity it
 * asserts are both refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as agendaGet } from '../src/app/api/agenda/route.ts';
import { applyCommand, createEmptyDomainState } from '../src/domain/stateMachine.ts';
import type { DomainState } from '../src/domain/stateMachine.ts';
import { configureCommandService } from '../lib/services/commandService.ts';
import { readEscalationCeiling } from '../lib/services/mobile/reminderSettingsService.ts';
import { createMemoryStorage } from '../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../lib/storage/index.ts';
import { userDoc } from '../lib/storage/paths.ts';

const BASE = 'http://127.0.0.1:4321';
const UID = 'user_ceiling_wiring';

// Due in April 2026, so the route's real clock always sees an overdue Must.
function stateWithOverdueMust(): DomainState {
  const drafted = applyCommand(createEmptyDomainState(), {
    type: 'CreateDraft',
    now: '2026-04-08T07:00:00.000Z',
    commitment: {
      id: 'must_call',
      kind: 'task',
      title: 'Call the bank',
      priority: { level: 'high' },
      timeSpec: { kind: 'due_by', dueAt: '2026-04-08T07:30:00.000Z', remindAt: null, timezone: 'UTC' },
    },
    draftStatus: 'pending_confirmation',
  }).newState;
  return applyCommand(drafted, {
    type: 'ConfirmCommitment',
    commitmentId: 'must_call',
    now: '2026-04-08T07:01:00.000Z',
    reminders: [],
  }).newState;
}

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  configureCommandService({ initialState: stateWithOverdueMust(), schedulerStore: null });
  return () => resetStorageForTests();
}

/** `undefined` stores a settings record with the ceiling field absent. */
async function storeCeiling(value: unknown): Promise<void> {
  await getStorage().set(userDoc(UID), {
    reminderSettings: {
      softEnabled: true,
      softLeadMinutes: 60,
      ...(value === undefined ? {} : { escalationCeiling: value }),
      updatedAt: '2026-04-08T07:00:00.000Z',
    },
  });
}

async function pressureCandidateFor(uid: string = UID): Promise<Record<string, unknown>> {
  const response = await agendaGet(new Request(`${BASE}/api/agenda?userId=${encodeURIComponent(uid)}`));
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  const candidate = body.pressureCandidate as Record<string, unknown> | undefined;
  assert.ok(candidate, 'an overdue Must must produce a pressure candidate');
  assert.equal(candidate.commitmentId, 'must_call');
  return candidate;
}

test('a stored hard ceiling lets an overdue Must reach the firm, high stage', async () => {
  const teardown = setup();
  try {
    await storeCeiling('hard');

    const candidate = await pressureCandidateFor();

    // The stage the default refuses: firm tone, full intensity (#446).
    assert.equal(candidate.tone, 'firm');
    assert.equal(candidate.intensity, 'high');
  } finally {
    teardown();
  }
});

test('with nothing stored the same agenda stays at the gentlest ceiling', async () => {
  const teardown = setup();
  try {
    const candidate = await pressureCandidateFor();

    assert.equal(candidate.tone, 'soft');
    assert.equal(candidate.intensity, 'low');
  } finally {
    teardown();
  }
});

test('a stored followUp ceiling holds the same agenda at medium', async () => {
  const teardown = setup();
  try {
    await storeCeiling('followUp');

    const candidate = await pressureCandidateFor();

    assert.equal(candidate.tone, 'soft');
    assert.equal(candidate.intensity, 'medium');
  } finally {
    teardown();
  }
});

test('a stored value off the whitelist reads as the gentlest ceiling (#199)', async () => {
  const teardown = setup();
  try {
    await storeCeiling('loudest');

    const candidate = await pressureCandidateFor();

    assert.equal(candidate.tone, 'soft');
    assert.equal(candidate.intensity, 'low');
    assert.equal(await readEscalationCeiling(UID), 'soft');
  } finally {
    teardown();
  }
});

test('an unreadable userId fails the ceiling read, not the agenda', async () => {
  const teardown = setup();
  try {
    const candidate = await pressureCandidateFor('not a uid');

    assert.equal(candidate.tone, 'soft');
    assert.equal(candidate.intensity, 'low');
  } finally {
    teardown();
  }
});
