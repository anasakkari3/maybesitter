/**
 * A past time is refused at the boundary, not only by the sheet (#352).
 *
 * The capture path has always refused a resolved time in the past —
 * `validateEdit` in `lib/services/captureBoundary/applyEdits.ts` — and the
 * Details edit sheet refuses one client-side. `PATCH
 * /api/mobile/commitments/:id` accepted it, so the rule held everywhere a
 * person could reach it through the UI and nowhere a request could reach it
 * directly. A reminder in the past is one that will never fire, and storing it
 * silently is worse than refusing it.
 *
 * ── Why this file never reads the wall clock ─────────────────────
 *
 * The three tests that pinned this bug wrote their patch times as literals in
 * a month that was in the future when they were written. They passed until the
 * calendar moved, and then they were asserting that the server accepts a past
 * time — the exact defect. So every instant below is measured from a clock the
 * test supplies: `patchCommitment` takes `now`, so a fixed reference date can
 * be injected and no assertion here can expire. The one case that goes through
 * the route handler, which reads `new Date()` itself, measures from a
 * reference taken when the file loads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCommand, configureCommandService } from '../../lib/services/commandService.ts';
import { getCommitment, patchCommitment } from '../../lib/services/mobile/commitmentService.ts';
import { InvalidEditError, validateEdit } from '../../lib/services/captureBoundary/applyEdits.ts';
import { createEmptyDomainState, type Command } from '../../src/domain/stateMachine.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { PATCH as commitmentPatch } from '../../src/app/api/mobile/commitments/[id]/route.ts';

const HOUR = 3_600_000;

/** The clock this file hands to the service. Injected, so it cannot expire. */
const NOW = new Date('2026-08-09T08:00:00.000Z');
const at = (hours: number): string => new Date(NOW.getTime() + hours * HOUR).toISOString();

const TIMEZONE = 'Asia/Jerusalem';
const ID = 'cmt_past_time_rule';

/**
 * One confirmed commitment in the process-local command service, timed by the
 * `hours` offset from `NOW` rather than by a literal.
 */
function seedCommitment(dueHours: number, remindHours: number | null): void {
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  applyCommand({
    type: 'CreateDraft',
    now: at(-72),
    commitment: {
      id: ID,
      kind: 'task',
      title: 'Call the dentist',
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: {
        kind: 'due_by',
        dueAt: at(dueHours),
        remindAt: remindHours === null ? null : at(remindHours),
        timezone: TIMEZONE,
      },
    },
    draftStatus: 'pending_confirmation',
  } as Command);
  applyCommand({ type: 'ConfirmCommitment', commitmentId: ID, now: at(-71) } as Command);
}

test('PATCH refuses a due date in the past, the way the capture path always has', async () => {
  seedCommitment(48, 46);
  await assert.rejects(
    patchCommitment(ID, { dueDate: at(-1) }, NOW),
    /dueDate must not be in the past/,
  );
  // Refused means nothing was written, not "written and then complained about".
  assert.equal((await getCommitment(ID))?.timeSpec.dueAt, at(48));
});

test('PATCH refuses a reminder time in the past', async () => {
  seedCommitment(48, 46);
  await assert.rejects(
    patchCommitment(ID, { reminderTime: at(-1) }, NOW),
    /reminderTime must not be in the past/,
  );
  assert.equal((await getCommitment(ID))?.timeSpec.remindAt, at(46));
});

test('a time the user is moving forward is still accepted', async () => {
  seedCommitment(48, 46);
  const patched = await patchCommitment(ID, { dueDate: at(72) }, NOW);
  assert.equal(patched.timeSpec.dueAt, at(72));
  // The lead the user chose still travels with the move (UC-0.2c, #134).
  assert.equal(patched.timeSpec.remindAt, at(70));
});

test('the rule judges the time the patch supplies, never the one already stored', async () => {
  // There is no "overdue" in this product: a commitment whose hour has gone is
  // ordinary, and refusing to fix a typo in its title because of its own time
  // would make yesterday's items uneditable forever.
  seedCommitment(-24, -26);
  const patched = await patchCommitment(ID, { title: 'Call the dentist back' }, NOW);
  assert.equal(patched.title, 'Call the dentist back');
  assert.equal(patched.timeSpec.dueAt, at(-24));
});

test('removing the time is still a choice a user can make, past or not', async () => {
  // `null` is "no time", not "a time"; the clock has nothing to say about it.
  seedCommitment(-24, -26);
  const patched = await patchCommitment(ID, { dueDate: null, reminderTime: null }, NOW);
  assert.equal(patched.timeSpec.kind, 'unscheduled');
  assert.equal(patched.timeSpec.dueAt, null);
  assert.equal(patched.timeSpec.remindAt, null);
});

/**
 * A bare `YYYY-MM-DD` is refused, and refused for being a date (#352).
 *
 * This is pinned because it is a decision and not a side effect. A date has no
 * hour; `parseIsoInstant` gives it UTC midnight, and that midnight then passes
 * or fails the clock check for reasons that have nothing to do with what the
 * user meant — today's date failed as "in the past", and a future date was
 * accepted and stored 00:00Z, which is 03:00 for this product's default
 * Asia/Jerusalem user. A reminder at three in the morning on an hour nobody
 * picked is not a better outcome than a refusal that says what is missing.
 */
test('a due date with no time of day is refused for being a date, not for its hour', async () => {
  seedCommitment(48, null);
  // Today, under the old rule, was answered "must not be in the past" — a true
  // sentence about a fabricated instant, and unreadable as advice.
  await assert.rejects(
    patchCommitment(ID, { dueDate: NOW.toISOString().slice(0, 10) }, NOW),
    /dueDate must name a time of day, not only a date/,
  );
  // A future date is refused by the same rule, where it used to be accepted
  // and silently given midnight UTC.
  await assert.rejects(
    patchCommitment(ID, { dueDate: at(240).slice(0, 10) }, NOW),
    /dueDate must name a time of day, not only a date/,
  );
  assert.equal((await getCommitment(ID))?.timeSpec.dueAt, at(48));
});

test('a reminder time with no time of day is refused the same way', async () => {
  seedCommitment(48, 46);
  await assert.rejects(
    patchCommitment(ID, { reminderTime: at(240).slice(0, 10) }, NOW),
    /reminderTime must name a time of day, not only a date/,
  );
});

/**
 * The claim the extraction was for: one rule, not two implementations that
 * happen to agree today. Both paths are asked about the same instants at the
 * same clock, and must give the same answer at the boundary between them.
 *
 * The `0` case is the boundary itself: `timeRules` compares with `<`, so an
 * instant of exactly `now` is a time the user picked and is allowed. The edit
 * sheet is one millisecond stricter (`<=`) on purpose — see the note on
 * `EditSheet` in `mobile/src/screens/Sheets.tsx`.
 */
test('the capture path and the PATCH path refuse and accept the same instants', async () => {
  const knownItems = new Set(['item-1']);
  const edit = (resolvedTime: string) => ({ itemId: 'item-1', resolvedTime });

  for (const offset of [-1, -0.001]) {
    seedCommitment(48, null);
    assert.throws(() => validateEdit(edit(at(offset)), knownItems, NOW), InvalidEditError, `capture at ${offset}h`);
    await assert.rejects(patchCommitment(ID, { dueDate: at(offset) }, NOW), /must not be in the past/, `patch at ${offset}h`);
  }

  for (const offset of [0, 1]) {
    seedCommitment(48, null);
    assert.equal(validateEdit(edit(at(offset)), knownItems, NOW).resolvedTime, at(offset), `capture at ${offset}h`);
    const patched = await patchCommitment(ID, { dueDate: at(offset) }, NOW);
    assert.equal(patched.timeSpec.dueAt, at(offset), `patch at ${offset}h`);
  }
});

/**
 * The wire shape, once. The route reads `new Date()`, so this one case is
 * measured from a reference taken at load rather than from an injected clock —
 * still relative, still unable to rot in either direction.
 */
const WALL_CLOCK = new Date();
const fromWallClock = (hours: number): string => new Date(WALL_CLOCK.getTime() + hours * HOUR).toISOString();

const USER = uidFor('PastTimeRuleUser');
const BASE = 'http://127.0.0.1:4321';

function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-past-time-'));
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  const previousDataDir = process.env.MAYBESITTER_DATA_DIR;
  process.env.MAYBESITTER_DATA_DIR = dir;
  setStorageForTests(createMemoryStorage());
  const auth: FakeAuthControls = installFakeAuth();
  return () => {
    auth.restore();
    resetStorageForTests();
    if (previousDataDir === undefined) delete process.env.MAYBESITTER_DATA_DIR;
    else process.env.MAYBESITTER_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

test('the route answers a past time with the refusal shape every other /api/mobile validation uses', async () => {
  const cleanup = setup();
  try {
    const proposal = await (await capturePost(post('/api/mobile/capture', {
      text: 'Call the dentist tomorrow at 3pm',
      referenceTime: WALL_CLOCK.toISOString(),
      timezone: 'UTC',
      scopeId: 'past-time-rule',
    }))).json() as { proposalId: string; items: Array<{ itemId: string }> };

    const confirmed = await (await confirmPost(post('/api/mobile/capture/confirm', {
      proposalId: proposal.proposalId,
      scopeId: 'past-time-rule',
      itemIds: [proposal.items[0]!.itemId],
    }))).json() as { persisted: Array<{ commitmentId: string }> };
    const commitmentId = confirmed.persisted[0]!.commitmentId;

    const refused = await commitmentPatch(
      new Request(`${BASE}/api/mobile/commitments/${commitmentId}`, {
        method: 'PATCH',
        headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' }),
        body: JSON.stringify({ dueDate: fromWallClock(-1) }),
      }),
      params(commitmentId),
    );
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { success: false, error: 'dueDate must not be in the past' });

    const accepted = await commitmentPatch(
      new Request(`${BASE}/api/mobile/commitments/${commitmentId}`, {
        method: 'PATCH',
        headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' }),
        body: JSON.stringify({ dueDate: fromWallClock(48) }),
      }),
      params(commitmentId),
    );
    assert.equal(accepted.status, 200);
  } finally {
    cleanup();
  }
});
