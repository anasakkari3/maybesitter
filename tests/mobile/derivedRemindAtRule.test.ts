/**
 * A reminder this patch derives is refused like one the client sent (#375).
 *
 * When a patch moves only `dueDate`, `patchTimeSpec` keeps the gap the user
 * chose and derives `remindAt = dueAt - lead` (#134). #352 gave the supplied
 * fields the clock and left the derived one without it, so the boundary refused
 * `reminderTime: now - 1h` and accepted the identical instant when it arrived
 * as a consequence of `dueDate: now + 1h` on an item with a two-hour lead. The
 * stored reminder was an hour behind the clock — one that will never fire — and
 * the edit reported success.
 *
 * The decision is to refuse, explicitly. Clamping the lead or dropping the
 * reminder both change a time the user chose without saying so, and the edit
 * sheet would go on showing a reminder the server had quietly moved or removed.
 * A refusal is the only outcome the user can act on, so it names what collided
 * and what to do about it.
 *
 * ── Why nothing here reads the wall clock ────────────────────────
 *
 * Same reason as `patchPastTimeRule.test.ts`: an instant written as a literal
 * stops testing the rule the moment the calendar passes it, and stops loudly
 * only if you are lucky. `patchCommitment` takes `now`, so every instant below
 * is measured from a clock this file supplies. The one case that goes through
 * the route handler, which reads `new Date()` itself, measures from a reference
 * taken when the file loads.
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
import { PATCH as commitmentPatch, GET as commitmentGet } from '../../src/app/api/mobile/commitments/[id]/route.ts';

const HOUR = 3_600_000;

/** The clock this file hands to the service. Injected, so it cannot expire. */
const NOW = new Date('2026-08-09T08:00:00.000Z');
const at = (hours: number): string => new Date(NOW.getTime() + hours * HOUR).toISOString();
const atMs = (millis: number): string => new Date(NOW.getTime() + millis).toISOString();

const TIMEZONE = 'Asia/Jerusalem';
const ID = 'cmt_derived_remind_at';

/** The sentence the boundary answers a derived reminder in the past with. */
const REFUSAL =
  "dueDate is sooner than this commitment's reminder lead, so the reminder would land in the past: "
  + 'send reminderTime with it, or move the due date later';

/** One confirmed commitment, timed by offsets from `NOW` rather than literals. */
function seedCommitment(dueHours: number, remindHours: number | null): void {
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  applyCommand({
    type: 'CreateDraft',
    now: at(-72),
    commitment: {
      id: ID,
      kind: 'task',
      title: 'Collect the prescription',
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

test('PATCH refuses a due date whose preserved lead puts the reminder behind the clock', async () => {
  // The exact shape from #375: a two-hour lead, and a move to an hour from now.
  seedCommitment(48, 46);
  await assert.rejects(patchCommitment(ID, { dueDate: at(1) }, NOW), (error: Error) => {
    assert.equal(error.message, REFUSAL);
    return true;
  });
});

test('a refused derived reminder writes nothing at all', async () => {
  seedCommitment(48, 46);
  const before = await getCommitment(ID);
  await assert.rejects(patchCommitment(ID, { dueDate: at(1) }, NOW));
  const after = await getCommitment(ID);
  // Not just the reminder: the due date the patch did supply, and which passed
  // its own check, must not have landed either. One field of a refused patch is
  // a state the user never asked for and cannot see.
  assert.equal(after?.timeSpec.dueAt, at(48));
  assert.equal(after?.timeSpec.remindAt, at(46));
  assert.deepEqual(after, before, 'a refused patch changed the commitment');
});

test('a derived reminder of exactly now is allowed, and one millisecond earlier is not', async () => {
  // `timeRules` compares with `<`: an instant of exactly `now` is a time the
  // user's own lead produced, and the boundary is exclusive so it stays one.
  // The derived value has to sit on the same side of that line as a supplied
  // one, or the two rules have drifted apart again.
  seedCommitment(48, 46);
  const exactly = await patchCommitment(ID, { dueDate: at(2) }, NOW);
  assert.equal(exactly.timeSpec.remindAt, at(0));

  seedCommitment(48, 46);
  await assert.rejects(
    patchCommitment(ID, { dueDate: atMs(2 * HOUR - 1) }, NOW),
    (error: Error) => error.message === REFUSAL,
  );
});

test('a lead that still fits is carried with the move, exactly as before', async () => {
  seedCommitment(48, 46);
  const patched = await patchCommitment(ID, { dueDate: at(72) }, NOW);
  assert.equal(patched.timeSpec.dueAt, at(72));
  assert.equal(patched.timeSpec.remindAt, at(70));
});

test('the rule judges the reminder this patch derives, never the one already stored', async () => {
  // There is no "overdue" here. An item whose hour has gone — reminder included
  // — must stay movable, or the only way out of a stale commitment would be to
  // delete it.
  seedCommitment(-24, -26);
  const patched = await patchCommitment(ID, { dueDate: at(48) }, NOW);
  assert.equal(patched.timeSpec.dueAt, at(48));
  assert.equal(patched.timeSpec.remindAt, at(46));
});

test('an explicit reminderTime is judged as itself, not through the old lead', async () => {
  // Supplying the reminder is one of the two ways out the refusal names, so it
  // has to work from exactly the state that refuses: the same too-soon due date,
  // with a reminder the user chose for it.
  seedCommitment(48, 46);
  const patched = await patchCommitment(ID, { dueDate: at(1), reminderTime: at(0.5) }, NOW);
  assert.equal(patched.timeSpec.dueAt, at(1));
  assert.equal(patched.timeSpec.remindAt, at(0.5));
});

test('dropping the reminder is the other way out, and is not refused', async () => {
  seedCommitment(48, 46);
  const patched = await patchCommitment(ID, { dueDate: at(1), reminderTime: null }, NOW);
  assert.equal(patched.timeSpec.dueAt, at(1));
  assert.equal(patched.timeSpec.remindAt, null);
});

/**
 * The capture path's half of the bare-date rule (#352, reconciled here).
 *
 * #352 refused `YYYY-MM-DD` on the PATCH path because `parseIsoInstant` gives it
 * UTC midnight — 03:00 for this product's default Asia/Jerusalem user — so a
 * *future* bare date was accepted and scheduled a reminder at three in the
 * morning on an hour nobody chose. It left `validateEdit` alone, because its
 * brief was to keep the capture path's behaviour identical, and noted the
 * asymmetry. `Date.parse('2099-01-15')` is the same UTC midnight, so the same
 * bare date passed there.
 *
 * The instants below are fixed literals rather than offsets because the claim
 * is about shape, not about the clock: `2099-01-15` is a date whichever year
 * this runs in, and it has to be refused for having no hour rather than for
 * being on either side of `now`.
 */
test('the capture path refuses a resolved time that is a date with no time of day', async () => {
  const knownItems = new Set(['item-1']);
  assert.throws(
    () => validateEdit({ itemId: 'item-1', resolvedTime: '2099-01-15' }, knownItems, NOW),
    (error: unknown) => {
      assert.ok(error instanceof InvalidEditError);
      assert.equal(error.field, 'resolvedTime');
      // Refused for being a date. Not for the hour a parser would have invented
      // for it, which is the distinction the whole rule exists to make.
      assert.equal(error.detail, 'a date with no time of day');
      return true;
    },
  );
});

test('a date with a time of day is still accepted on the capture path', async () => {
  const knownItems = new Set(['item-1']);
  const normalised = validateEdit(
    { itemId: 'item-1', resolvedTime: '2099-01-15T09:30:00.000Z' },
    new Set(knownItems),
    NOW,
  );
  assert.equal(normalised.resolvedTime, '2099-01-15T09:30:00.000Z');
});

test('the capture path and the PATCH path both refuse a bare date, each in its own words', async () => {
  // The claim #352 could not make: one rule about the shape of a time, asked at
  // both boundaries, answered in the vocabulary each caller already reads.
  const knownItems = new Set(['item-1']);
  for (const bare of ['2099-01-15', NOW.toISOString().slice(0, 10)]) {
    assert.throws(
      () => validateEdit({ itemId: 'item-1', resolvedTime: bare }, knownItems, NOW),
      InvalidEditError,
      `capture accepted ${bare}`,
    );
    seedCommitment(48, null);
    await assert.rejects(
      patchCommitment(ID, { dueDate: bare }, NOW),
      /dueDate must name a time of day, not only a date/,
      `patch accepted ${bare}`,
    );
  }
});

/**
 * The wire shape, once. The route reads `new Date()`, so this case is measured
 * from a reference taken at load — still relative, still unable to rot.
 */
const WALL_CLOCK = new Date();
const fromWallClock = (hours: number): string => new Date(WALL_CLOCK.getTime() + hours * HOUR).toISOString();

const USER = uidFor('DerivedRemindAtUser');
const BASE = 'http://127.0.0.1:4322';

function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-derived-remind-'));
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

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(id: string, body: unknown): Request {
  return new Request(`${BASE}/api/mobile/commitments/${id}`, {
    method: 'PATCH',
    headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

test('the route answers a derived past reminder with the same refusal shape as every other validation', async () => {
  const cleanup = setup();
  try {
    const { POST: capturePost } = await import('../../src/app/api/mobile/capture/route.ts');
    const { POST: confirmPost } = await import('../../src/app/api/mobile/capture/confirm/route.ts');
    const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });

    const proposal = await (await capturePost(post('/api/mobile/capture', {
      text: 'Collect the prescription tomorrow at 3pm',
      referenceTime: WALL_CLOCK.toISOString(),
      timezone: 'UTC',
      scopeId: 'derived-remind-at',
    }))).json() as { proposalId: string; items: Array<{ itemId: string }> };

    const confirmed = await (await confirmPost(post('/api/mobile/capture/confirm', {
      proposalId: proposal.proposalId,
      scopeId: 'derived-remind-at',
      itemIds: [proposal.items[0]!.itemId],
    }))).json() as { persisted: Array<{ commitmentId: string }> };
    const id = confirmed.persisted[0]!.commitmentId;

    // Capture stores one instant as both due and reminder, so the lead is zero
    // and nothing can be derived into the past yet. The user choosing a lead is
    // the precondition for the bug, so choose one the way a user would.
    const withLead = await commitmentPatch(
      patchRequest(id, { dueDate: fromWallClock(48), reminderTime: fromWallClock(46) }),
      params(id),
    );
    assert.equal(withLead.status, 200);

    const refused = await commitmentPatch(patchRequest(id, { dueDate: fromWallClock(1) }), params(id));
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { success: false, error: REFUSAL });

    // The commitment the next screen reads is the one from before the refusal.
    const after = await (await commitmentGet(
      new Request(`${BASE}/api/mobile/commitments/${id}`, {
        headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}` }),
      }),
      params(id),
    )).json() as { timeSpec: { dueAt: string; remindAt: string } };
    assert.equal(after.timeSpec.dueAt, fromWallClock(48));
    assert.equal(after.timeSpec.remindAt, fromWallClock(46));
  } finally {
    cleanup();
  }
});
