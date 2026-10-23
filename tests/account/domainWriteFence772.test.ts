/**
 * Domain writes re-read the account deletion fence (#772).
 *
 * Account deletion marks `users/{uid}.trust.deletedAt`, then sweeps the whole
 * user tree. A request that authenticated before either step is still on its
 * way to its write. Before this fence, that write landed anyway: the edit
 * re-wrote the commitment under a deleted account, and a create after the sweep
 * re-created the commitment *and* a fresh user document, undoing the deletion.
 *
 * The race is staged deterministically: the storage is wrapped so that the
 * deletion step (markDeleted, or markDeleted plus the sweep) commits at the
 * request's first storage write — after authentication and after every
 * pre-read the route makes, immediately before the write itself. Every case
 * runs twice, once per deletion step, and asserts what is left under
 * `users/{uid}` afterwards:
 *
 *   - markDeleted: the user document exactly as the deletion left it, and the
 *     account's documents unchanged;
 *   - swept: nothing at all.
 *
 * Routes answer the refusal the way they answer a deleted account at sign-in:
 * 403, `reason: 'deleted'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { AccountUnavailableError } from '../../lib/account/accountLiveness.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { applyParticipantCommands, getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { PATCH as commitmentPatch } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { GET as habitsGet, POST as habitsPost } from '../../src/app/api/mobile/habits/route.ts';
import { createStorageHabitOccurrenceStore } from '../../lib/services/habits/habitOccurrenceStore.ts';
import { POST as completePost } from '../../src/app/api/mobile/habits/[id]/occurrences/[occurrenceId]/complete/route.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const REFERENCE = new Date('2026-10-03T09:13:00.000Z');
const CAPTURE = 'عندي امتحان رياضيات بكرا الساعة 10';

type Step = 'markDeleted' | 'swept';
const STEPS: readonly Step[] = ['markDeleted', 'swept'];

/* ── harness ─────────────────────────────────────────────────────────── */

interface Harness {
  uid: string;
  base: MemoryStorageAdapter;
  /** Commits the deletion step at the next storage write, then lets it run. */
  armDeletion(step: Step): void;
  /** Whether the armed deletion actually fired (the race really happened). */
  fired(): boolean;
}

let auth: FakeAuthControls | null = null;

/**
 * The memory adapter, with a one-shot hook in front of every write entry point
 * (`set`, `delete`, `runTransaction`). Reads pass straight through, so the
 * route's authentication and pre-reads see the live account.
 */
function raceable(base: MemoryStorageAdapter): { storage: StorageAdapter; arm(fn: () => Promise<void>): void; fired(): boolean } {
  let pending: (() => Promise<void>) | null = null;
  let didFire = false;
  const writes = new Set(['set', 'delete', 'runTransaction']);
  const storage = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && writes.has(property)) {
        return async (...args: unknown[]) => {
          if (pending) {
            const deletion = pending;
            pending = null;
            didFire = true;
            await deletion();
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as unknown as StorageAdapter;
  return {
    storage,
    arm(fn) { pending = fn; didFire = false; },
    fired: () => didFire,
  };
}

/** `markDeleted`, as account deletion writes it, straight to the base adapter. */
async function markDeleted(base: StorageAdapter, uid: string): Promise<void> {
  const at = new Date().toISOString();
  const user = (await base.get<Record<string, any>>(userDoc(uid))) ?? {};
  await base.set(userDoc(uid), { ...user, trust: { ...(user.trust ?? {}), deletedAt: at, updatedAt: at } });
}

async function withHarness(name: string, run: (h: Harness) => Promise<void>): Promise<void> {
  auth = installFakeAuth();
  const base = createMemoryStorage();
  const wrapped = raceable(base);
  setStorageForTests(wrapped.storage);
  const uid = uidFor(`fence772${name.replace(/[^A-Za-z0-9]/g, '')}`);
  try {
    // A real first request: authentication creates the user document and
    // its trust record, exactly as in production.
    const warm = await habitsGet(request('GET', '/api/mobile/habits', uid));
    assert.equal(warm.status, 200);
    await run({
      uid,
      base,
      armDeletion(step) {
        wrapped.arm(async () => {
          await markDeleted(base, uid);
          if (step === 'swept') await base.deleteTree(userDoc(uid));
        });
      },
      fired: wrapped.fired,
    });
  } finally {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  }
}

function request(method: string, path: string, uid: string, body?: unknown, timezone = TZ): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const url = new URL(`${BASE}${path}`);
  if (timezone) url.searchParams.set('timezone', timezone);
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

type Tree = Record<string, unknown>;

/** Every stored path under `users/{uid}`, the document itself included, with its data. */
async function snapshot(base: MemoryStorageAdapter, uid: string): Promise<Tree> {
  const prefix = `${userDoc(uid)}/`;
  const paths = base.pathsForTests().filter((path) => path === userDoc(uid) || path.startsWith(prefix)).sort();
  const out: Tree = {};
  for (const path of paths) out[path] = await base.get(path);
  return out;
}

/** The tree as it must be once the deletion step has run: swept is empty. */
async function expectedAfterDeletion(h: Harness, step: Step): Promise<Tree> {
  return step === 'swept' ? {} : snapshot(h.base, h.uid);
}

/**
 * What must be left once the refused write is over. markDeleted: the tree as
 * it stood, document for document, except the deletion's own trust mark on the
 * user document. Swept: nothing.
 */
async function assertNothingWrittenAfter(h: Harness, step: Step, expected: Tree, what: string): Promise<void> {
  assert.ok(h.fired(), `${what}: the deletion step never ran, so the race was not staged`);
  const now = await snapshot(h.base, h.uid);
  if (step === 'swept') {
    assert.deepEqual(Object.keys(now), [], `${what}: documents re-created under a swept account`);
    return;
  }
  const user = now[userDoc(h.uid)] as Record<string, any> | undefined;
  assert.ok(user?.trust?.deletedAt, `${what}: the user document lost its deletion mark`);
  const want: Tree = { ...expected, [userDoc(h.uid)]: { ...(expected[userDoc(h.uid)] as object), trust: user!.trust } };
  assert.deepEqual(Object.keys(now), Object.keys(want), `${what}: the set of documents changed`);
  for (const path of Object.keys(want)) assert.deepEqual(now[path], want[path], `${what}: ${path} was written`);
}

async function assertDeletedResponse(response: Response, what: string): Promise<void> {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 403, `${what}: ${JSON.stringify(body)}`);
  assert.equal(body.success, false);
  assert.equal(body.reason, 'deleted');
}

/* ── fixtures ────────────────────────────────────────────────────────── */

async function proposal(uid: string) {
  const proposed = await proposeMobileCapture({ text: CAPTURE, timezone: TZ, referenceTime: REFERENCE.toISOString() }, { participantId: uid });
  assert.equal(proposed.items.length, 1, JSON.stringify(proposed.items.map((item) => item.title)));
  return proposed;
}

async function oneCommitment(uid: string): Promise<string> {
  const id = 'fence-772-commitment';
  const now = new Date().toISOString();
  await applyParticipantCommands(uid, [
    { type: 'CreateDraft', now, commitment: { id, kind: 'task', title: 'Renew the passport' }, draftStatus: 'pending_confirmation' },
    { type: 'ConfirmCommitment', commitmentId: id, now },
  ]);
  return id;
}

const HABIT = {
  title: 'Morning run',
  cadence: { kind: 'weekdays', weekdays: [1] },
  durationMinutes: 45,
  preferredWindows: [{ start: '07:00', end: '08:00' }],
  minimumOccurrences: 1,
  maximumOccurrences: 1,
  flexibility: 'protected_flexible',
  recoveryPolicy: 'recover_within_period',
  source: 'user_created',
  confirmation: { confirmedByUserAt: '2026-10-01T09:00:00.000Z', sourceRef: null, acceptedSuggestedValues: false },
};

/* ── capture confirm / domain command ────────────────────────────────── */

for (const step of STEPS) {
  test(`capture confirm: a confirm in flight when the account is ${step} writes nothing and answers 403 deleted`, async () => {
    await withHarness(`confirm${step}`, async (h) => {
      const proposed = await proposal(h.uid);
      const expected = await expectedAfterDeletion(h, step);
      h.armDeletion(step);
      const response = await confirmPost(request('POST', '/api/mobile/capture/confirm', h.uid, {
        proposalId: proposed.proposalId,
        itemIds: [proposed.items[0]!.itemId],
      }));
      await assertDeletedResponse(response, 'confirm');
      await assertNothingWrittenAfter(h, step, expected, 'confirm');
    });
  });

  test(`domain command: commands applied after the account is ${step} are refused as AccountUnavailableError`, async () => {
    await withHarness(`command${step}`, async (h) => {
      const expected = await expectedAfterDeletion(h, step);
      h.armDeletion(step);
      await assert.rejects(oneCommitment(h.uid), AccountUnavailableError);
      await assertNothingWrittenAfter(h, step, expected, 'applyParticipantCommands');
    });
  });
}

/* ── commitment edit ─────────────────────────────────────────────────── */

for (const step of STEPS) {
  test(`commitment edit: a PATCH in flight when the account is ${step} writes nothing and answers 403 deleted`, async () => {
    await withHarness(`edit${step}`, async (h) => {
      const id = await oneCommitment(h.uid);
      const versionBefore = (await h.base.get<Record<string, any>>(userDoc(h.uid)))!.domainVersion;
      assert.ok(versionBefore >= 1);
      const expected = await expectedAfterDeletion(h, step);
      h.armDeletion(step);
      const response = await commitmentPatch(
        request('PATCH', `/api/mobile/commitments/${id}`, h.uid, { title: 'Renew the passport today' }),
        { params: Promise.resolve({ id }) },
      );
      await assertDeletedResponse(response, 'patch');
      await assertNothingWrittenAfter(h, step, expected, 'patch');
      if (step === 'markDeleted') {
        const state = await getParticipantStateSnapshot(h.uid);
        assert.equal(state.commitments[id]?.title, 'Renew the passport');
      }
    });
  });
}

/* ── habits ──────────────────────────────────────────────────────────── */

for (const step of STEPS) {
  test(`habit create: a POST in flight when the account is ${step} writes no habit and no occurrence, and answers 403 deleted`, async () => {
    await withHarness(`habit${step}`, async (h) => {
      const expected = await expectedAfterDeletion(h, step);
      h.armDeletion(step);
      const response = await habitsPost(request('POST', '/api/mobile/habits', h.uid, HABIT, 'UTC'));
      await assertDeletedResponse(response, 'habit create');
      await assertNothingWrittenAfter(h, step, expected, 'habit create');
    });
  });

  test(`habit occurrence: completing one when the account is ${step} writes nothing and answers 403 deleted`, async () => {
    await withHarness(`occurrence${step}`, async (h) => {
      const created = await habitsPost(request('POST', '/api/mobile/habits', h.uid, HABIT, 'UTC'));
      assert.equal(created.status, 201);
      const body = await created.json() as { habit: { habitId?: string; id?: string }; occurrences: Array<{ occurrenceId?: string; id?: string }> };
      const habitId = (body.habit.habitId ?? body.habit.id)!;
      const occurrenceId = (body.occurrences[0]!.occurrenceId ?? body.occurrences[0]!.id)!;
      assert.ok(habitId && occurrenceId);
      const expected = await expectedAfterDeletion(h, step);
      h.armDeletion(step);
      const response = await completePost(
        request('POST', `/api/mobile/habits/${habitId}/occurrences/${occurrenceId}/complete`, h.uid, undefined, 'UTC'),
        { params: Promise.resolve({ id: habitId, occurrenceId }) },
      );
      await assertDeletedResponse(response, 'occurrence complete');
      await assertNothingWrittenAfter(h, step, expected, 'occurrence complete');
    });
  });
}

for (const step of STEPS) {
  test(`habit horizon: occurrences materialized after the account is ${step} are refused, none written`, async () => {
    await withHarness(`horizon${step}`, async (h) => {
      const created = await habitsPost(request('POST', '/api/mobile/habits', h.uid, HABIT, 'UTC'));
      assert.equal(created.status, 201);
      const { habit } = await created.json() as { habit: { habitId: string } };
      const occurrences = createStorageHabitOccurrenceStore();
      const rows = await occurrences.listForHabit(h.uid, habit.habitId);
      assert.ok(rows.length > 0);
      // The next re-materialization of the horizon, re-writing the same rows.
      const rewritten = rows.map((row) => ({ ...row, state: 'completed' as const }));
      const expected = await expectedAfterDeletion(h, step);
      h.armDeletion(step);
      await assert.rejects(occurrences.putMany(h.uid, rewritten), AccountUnavailableError);
      await assertNothingWrittenAfter(h, step, expected, 'putMany');
    });
  });
}
