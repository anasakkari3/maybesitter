/**
 * More user-content writers re-read the account deletion fence (#772 follow-up).
 *
 * #772 fenced the domain writes (`writeDomainDiff`) and the habit stores. This
 * covers the next writer families, each of which wrote under `users/{uid}`
 * without asking whether the account still existed:
 *
 *   - plans: `plans/{date}` and its ledger (`planStore`), the accept's ledger
 *     and counter commit (`planActions`), the push marker (`planPushRetry`);
 *   - capture and chat: the proposal store, the conversation store, the
 *     legacy clarification store;
 *   - goals: the goal-plan transactions, the goal graph's links and step
 *     proposals;
 *   - weekly blocks and seeds: the block document, its busy occurrences, the
 *     intent seed store.
 *
 * The race is staged the way `domainWriteFence772.test.ts` stages it: the
 * storage is wrapped so that the deletion step — markDeleted, or markDeleted
 * and the sweep — commits at the request's first storage write, after
 * authentication and every pre-read, immediately before the write itself.
 * Every case runs once per step and asserts what is left under `users/{uid}`:
 *
 *   - markDeleted: every document exactly as it was, except the deletion's own
 *     trust mark on the user document;
 *   - swept: nothing at all.
 *
 * Routes answer the refusal the way they answer a deleted account at sign-in:
 * 403, `reason: 'deleted'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { AccountUnavailableError } from '../../lib/account/accountLiveness.ts';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import { composeDailyPlan } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { createIfAbsent, planPath, type StoredDailyPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { claimPlanPushRetry } from '../../lib/services/dailyPlan/planPushRetry.ts';
import { POST as planActionsPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';
import { POST as planOpenedPost } from '../../src/app/api/mobile/plans/[date]/opened/route.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { CaptureConversationStore } from '../../lib/services/captureChat/conversationStore.ts';
import { StorageClarificationStore } from '../../lib/services/clarificationStore.ts';
import { createManualMemory } from '../../lib/services/mobile/memoryService.ts';
import { generateGoalPlan } from '../../lib/services/mobile/goalPlanService.ts';
import { goalPlanRouteError } from '../../lib/services/mobile/goalPlanRoute.ts';
import { POST as goalPreviewPost } from '../../src/app/api/mobile/goals/from-statement/preview/route.ts';
import { createStorageGoalNodeLinkStore } from '../../lib/goalGraph/linkStore.ts';
import {
  GOAL_STEP_PROPOSAL_SCHEMA_VERSION,
  createStorageGoalStepProposalStore,
  goalTextKeyFor,
} from '../../lib/goalGraph/stepProposalStore.ts';
import { createWeeklyBlock, materializeWeeklyBlock } from '../../lib/weeklyBlocks/weeklyBlockService.ts';
import { POST as weeklyBlocksPost } from '../../src/app/api/mobile/weekly-blocks/route.ts';
import { createStorageIntentSeedStore } from '../../lib/intentSeeds/intentSeedStore.ts';
import { POST as seedsPost } from '../../src/app/api/mobile/seeds/route.ts';
import { GET as habitsGet } from '../../src/app/api/mobile/habits/route.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const PLAN_DATE = '2026-09-14';
const PLAN_MORNING = '2026-09-14T04:00:00.000Z';

type Step = 'markDeleted' | 'swept';
const STEPS: readonly Step[] = ['markDeleted', 'swept'];

/* ── harness ─────────────────────────────────────────────────────────── */

interface Harness {
  uid: string;
  base: MemoryStorageAdapter;
  /** The wrapped adapter: the one the code under test is handed. */
  storage: StorageAdapter;
  /** Commits the deletion step at the next storage write, then lets it run. */
  armDeletion(step: Step): void;
  /** Whether the armed deletion actually fired (the race really happened). */
  fired(): boolean;
}

/**
 * The memory adapter, with a one-shot hook in front of every write entry point
 * (`set`, `delete`, `runTransaction`). Reads pass straight through, so the
 * request's authentication and pre-reads see the live account.
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
  return { storage, arm(fn) { pending = fn; didFire = false; }, fired: () => didFire };
}

/** `markDeleted`, as account deletion writes it, straight to the base adapter. */
async function markDeleted(base: StorageAdapter, uid: string): Promise<void> {
  const at = new Date().toISOString();
  const user = (await base.get<Record<string, any>>(userDoc(uid))) ?? {};
  await base.set(userDoc(uid), { ...user, trust: { ...(user.trust ?? {}), deletedAt: at, updatedAt: at } });
}

let auth: FakeAuthControls | null = null;

/**
 * A live account on a fresh memory adapter. `viaRoute` warms it the way
 * production does — a real first request whose authentication creates the
 * trust record — and installs the fake verifier the routes need; otherwise
 * the account is seeded directly (`seedLiveAccount`).
 */
async function withHarness(name: string, options: { viaRoute: boolean }, run: (h: Harness) => Promise<void>): Promise<void> {
  const base = createMemoryStorage();
  const wrapped = raceable(base);
  setStorageForTests(wrapped.storage);
  const uid = uidFor(`fence772b${name.replace(/[^A-Za-z0-9]/g, '')}`);
  if (options.viaRoute) auth = installFakeAuth();
  try {
    if (options.viaRoute) {
      const warm = await habitsGet(request('GET', '/api/mobile/habits', uid));
      assert.equal(warm.status, 200);
    } else {
      await seedLiveAccount(uid, base);
    }
    const user = await base.get<Record<string, unknown>>(userDoc(uid));
    await base.set(userDoc(uid), { ...user, timezone: TZ, locale: 'en' });
    await run({
      uid,
      base,
      storage: wrapped.storage,
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

function request(method: string, path: string, uid: string, body?: unknown): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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

/**
 * What must be left once the refused write is over. markDeleted: the tree as
 * it stood, document for document, except the deletion's own trust mark on the
 * user document. Swept: nothing.
 */
async function assertNothingWrittenAfter(h: Harness, step: Step, before: Tree, what: string): Promise<void> {
  assert.ok(h.fired(), `${what}: the deletion step never ran, so the race was not staged`);
  const now = await snapshot(h.base, h.uid);
  if (step === 'swept') {
    assert.deepEqual(Object.keys(now), [], `${what}: documents re-created under a swept account`);
    return;
  }
  const user = now[userDoc(h.uid)] as Record<string, any> | undefined;
  assert.ok(user?.trust?.deletedAt, `${what}: the user document lost its deletion mark`);
  const want: Tree = { ...before, [userDoc(h.uid)]: { ...(before[userDoc(h.uid)] as object), trust: user!.trust } };
  assert.deepEqual(Object.keys(now), Object.keys(want), `${what}: the set of documents changed`);
  for (const path of Object.keys(want)) assert.deepEqual(now[path], want[path], `${what}: ${path} was written`);
}

async function assertDeletedResponse(response: Response, what: string): Promise<void> {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 403, `${what}: ${JSON.stringify(body)}`);
  assert.equal(body.success, false);
  assert.equal(body.reason, 'deleted');
}

/** Stages one case: snapshot, arm, act, then hold the tree to the step. */
async function race(h: Harness, step: Step, what: string, act: () => Promise<void>): Promise<void> {
  const before = await snapshot(h.base, h.uid);
  h.armDeletion(step);
  await act();
  await assertNothingWrittenAfter(h, step, before, what);
}

/* ── fixtures ────────────────────────────────────────────────────────── */

/** One confirmed task, so a plan has something to place. */
async function oneTask(uid: string): Promise<void> {
  await applyParticipantCommands(uid, [
    {
      type: 'CreateDraft',
      now: '2026-09-14T03:00:00.000Z',
      commitment: { id: 'fence-772b-task', kind: 'task', title: 'Write the summary', timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
    },
    { type: 'ConfirmCommitment', commitmentId: 'fence-772b-task', now: '2026-09-14T03:01:00.000Z' },
  ]);
}

/** A plan for `PLAN_DATE` that places the task, built the way the morning job builds one. */
async function composedPlan(uid: string, storage: StorageAdapter): Promise<StoredDailyPlan> {
  const document = await composeDailyPlan(uid, PLAN_DATE, { timezone: TZ }, 1, { storage, now: () => new Date(PLAN_MORNING) });
  assert.ok(document.plan.scheduled.length > 0, 'fixture: the plan places nothing');
  return document;
}

async function storedPlan(h: Harness): Promise<StoredDailyPlan> {
  await oneTask(h.uid);
  const document = await composedPlan(h.uid, h.base);
  const { created } = await createIfAbsent(h.uid, document, h.base);
  assert.equal(created, true);
  return document;
}

function planParams(date: string): { params: Promise<{ date: string }> } {
  return { params: Promise.resolve({ date }) };
}

const WEEKLY = { title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00', timezone: TZ };

/* ── plans ───────────────────────────────────────────────────────────── */

for (const step of STEPS) {
  test(`plans: the morning build's createIfAbsent, when the account is ${step}, writes no plan and is refused`, async () => {
    await withHarness(`planCreate${step}`, { viaRoute: false }, async (h) => {
      await oneTask(h.uid);
      const document = await composedPlan(h.uid, h.base);
      await race(h, step, 'createIfAbsent', async () => {
        await assert.rejects(createIfAbsent(h.uid, document, h.storage), AccountUnavailableError);
      });
    });
  });

  test(`plans: accepting a plan when the account is ${step} writes no status, ledger or counter, and answers 403`, async () => {
    await withHarness(`planAccept${step}`, { viaRoute: true }, async (h) => {
      await storedPlan(h);
      await race(h, step, 'accept', async () => {
        const response = await planActionsPost(request('POST', `/api/mobile/plans/${PLAN_DATE}/actions`, h.uid, { action: 'accept' }), planParams(PLAN_DATE));
        await assertDeletedResponse(response, 'accept');
      });
      if (step === 'markDeleted') {
        const plan = await h.base.get<StoredDailyPlan>(planPath(h.uid, PLAN_DATE));
        assert.equal(plan?.status, 'proposed', 'the plan was accepted under a deleted account');
      }
    });
  });

  test(`plans: the opened ledger entry, when the account is ${step}, is not appended and answers 403`, async () => {
    await withHarness(`planOpened${step}`, { viaRoute: true }, async (h) => {
      await storedPlan(h);
      await race(h, step, 'opened', async () => {
        // The route read the plan before the deletion landed; the append is
        // what the fence refuses.
        const response = await planOpenedPost(request('POST', `/api/mobile/plans/${PLAN_DATE}/opened`, h.uid, {}), planParams(PLAN_DATE));
        await assertDeletedResponse(response, 'opened');
      });
    });
  });
}

test('plans: a pending push on an account being deleted is neither claimed nor rewritten', async () => {
  await withHarness('planPush', { viaRoute: false }, async (h) => {
    const document = await storedPlan(h);
    await h.base.set(planPath(h.uid, PLAN_DATE), {
      ...document,
      pushPending: { attempts: 1, failedSends: 1, nextAttemptAt: '2026-09-14T04:05:00.000Z', reason: 'send_failed' },
    });
    await race(h, 'markDeleted', 'push claim', async () => {
      const claim = await claimPlanPushRetry(h.uid, PLAN_DATE, new Date('2026-09-14T04:10:00.000Z'), h.storage);
      assert.deepEqual(claim, { kind: 'not_due' });
    });
  });
});

/* ── capture and chat ────────────────────────────────────────────────── */

for (const step of STEPS) {
  test(`capture: a capture in flight when the account is ${step} stores no proposal and answers 403`, async () => {
    await withHarness(`capture${step}`, { viaRoute: true }, async (h) => {
      await race(h, step, 'capture', async () => {
        const response = await capturePost(request('POST', '/api/mobile/capture', h.uid, {
          text: 'Call the bank tomorrow at 10',
          timezone: TZ,
          referenceTime: '2026-10-03T09:13:00.000Z',
        }));
        await assertDeletedResponse(response, 'capture');
      });
    });
  });

  test(`chat: a conversation written when the account is ${step} is refused and not stored`, async () => {
    await withHarness(`chat${step}`, { viaRoute: false }, async (h) => {
      const at = '2026-10-03T09:13:00.000Z';
      await race(h, step, 'conversation', async () => {
        await assert.rejects(new CaptureConversationStore(h.storage).put(h.uid, {
          conversationId: '0f1e2d3c-4b5a-4968-8776-655443322110',
          turns: [{ role: 'user', text: 'Call the bank tomorrow' }],
          proposalId: null,
          createdAt: at,
          updatedAt: at,
        }, new Date(at)), AccountUnavailableError);
      });
    });
  });

  test(`clarification: a legacy clarification for an account that is ${step} is refused and not stored`, async () => {
    await withHarness(`clarify${step}`, { viaRoute: false }, async (h) => {
      await race(h, step, 'clarification', async () => {
        await assert.rejects(new StorageClarificationStore(h.storage).create({
          scopeId: h.uid,
          accountUid: h.uid,
          originalInput: 'call the bank',
          partialExtraction: { type: 'task', title: 'Call the bank', missingFields: ['time'] } as never,
          now: new Date('2026-10-03T09:13:00.000Z'),
          ttlMs: 600_000,
        }), AccountUnavailableError);
      });
    });
  });
}

/* ── goals ───────────────────────────────────────────────────────────── */

const GOAL_TEXT = 'Run a half marathon by the spring';

for (const step of STEPS) {
  test(`goals: generating a plan when the account is ${step} claims nothing, writes no draft and is refused`, async () => {
    await withHarness(`goalGenerate${step}`, { viaRoute: false }, async (h) => {
      const goal = await createManualMemory(h.uid, { kind: 'goal', content: GOAL_TEXT, language: 'en' }, '2026-10-03T09:00:00.000Z', { storage: h.base });
      await race(h, step, 'generateGoalPlan', async () => {
        await assert.rejects(
          generateGoalPlan(h.uid, goal.id, { idempotencyKey: 'fence-772b-generate', source: 'template' }, h.storage),
          AccountUnavailableError,
        );
      });
    });
  });

  test(`goals: a statement preview when the account is ${step} is not stored and answers 403`, async () => {
    const previous = process.env.MAYBESITTER_FEATURE_GOAL_PLAN;
    process.env.MAYBESITTER_FEATURE_GOAL_PLAN = 'true';
    try {
      await withHarness(`goalPreview${step}`, { viaRoute: true }, async (h) => {
        await race(h, step, 'goal preview', async () => {
          const response = await goalPreviewPost(request('POST', '/api/mobile/goals/from-statement/preview', h.uid, {
            statement: 'I want to run a half marathon', locale: 'en',
          }));
          await assertDeletedResponse(response, 'goal preview');
        });
      });
    } finally {
      if (previous === undefined) delete process.env.MAYBESITTER_FEATURE_GOAL_PLAN;
      else process.env.MAYBESITTER_FEATURE_GOAL_PLAN = previous;
    }
  });

  test(`goal graph: a link claim and a step proposal when the account is ${step} are refused and not stored`, async () => {
    await withHarness(`goalGraph${step}`, { viaRoute: false }, async (h) => {
      await race(h, step, 'link claim', async () => {
        await assert.rejects(createStorageGoalNodeLinkStore(h.storage).claim({
          scopeId: h.uid,
          goalMemoryId: 'goal-772b',
          nodeId: 'step.s1',
          generation: 1,
          entityKind: 'commitment',
          confirmedByUserAt: '2026-10-03T09:00:00.000Z',
        }, '2026-10-03T09:00:00.000Z'), AccountUnavailableError);
      });
      if (step === 'swept') return; // the account is gone; the second write is the same case
      await race(h, step, 'step proposal', async () => {
        await assert.rejects(createStorageGoalStepProposalStore(h.storage).putIfAbsent(h.uid, {
          schemaVersion: GOAL_STEP_PROPOSAL_SCHEMA_VERSION,
          goalMemoryId: 'goal-772b',
          generation: 1,
          goalTextKey: goalTextKeyFor(GOAL_TEXT),
          steps: [],
          promptVersion: 'test',
          model: null,
          createdAt: '2026-10-03T09:00:00.000Z',
        }), AccountUnavailableError);
      });
    });
  });
}

test('goals: the goal-plan routes answer AccountUnavailableError as 403 deleted, not 500', async () => {
  await assertDeletedResponse(goalPlanRouteError(new AccountUnavailableError()), 'goalPlanRouteError');
});

/* ── weekly blocks and seeds ─────────────────────────────────────────── */

for (const step of STEPS) {
  test(`weekly blocks: creating a block when the account is ${step} stores no block or busy time and answers 403`, async () => {
    await withHarness(`weeklyCreate${step}`, { viaRoute: true }, async (h) => {
      await race(h, step, 'weekly create', async () => {
        const response = await weeklyBlocksPost(request('POST', '/api/mobile/weekly-blocks', h.uid, {
          ...WEEKLY, confirmation: { confirmedByUserAt: '2026-09-29T08:59:00.000Z' },
        }));
        await assertDeletedResponse(response, 'weekly create');
      });
    });
  });

  test(`weekly blocks: renewing a block's occurrences when the account is ${step} writes no busy time and is refused`, async () => {
    await withHarness(`weeklyRenew${step}`, { viaRoute: false }, async (h) => {
      const created = new Date('2026-09-29T09:00:00.000Z');
      const { block } = await createWeeklyBlock(h.uid, { ...WEEKLY, confirmedAt: created.toISOString() }, { storage: h.base, now: created });
      // A week and a day later: the horizon has moved, so a renewal has new
      // occurrences to write.
      const later = new Date(created.getTime() + 8 * 86_400_000);
      await race(h, step, 'weekly renew', async () => {
        await assert.rejects(materializeWeeklyBlock(h.uid, block, { storage: h.storage, now: later }), AccountUnavailableError);
      });
    });
  });

  test(`seeds: keeping a seed when the account is ${step} stores nothing and answers 403`, async () => {
    await withHarness(`seedCreate${step}`, { viaRoute: true }, async (h) => {
      await race(h, step, 'seed create', async () => {
        const response = await seedsPost(request('POST', '/api/mobile/seeds', h.uid, {
          kind: 'idea', summary: 'Learn to bake bread', idempotencyKey: 'fence-772b-seed',
        }));
        await assertDeletedResponse(response, 'seed create');
      });
    });
  });

  test(`seeds: editing a seed when the account is ${step} is refused and the seed is unchanged`, async () => {
    await withHarness(`seedPatch${step}`, { viaRoute: false }, async (h) => {
      const created = await createStorageIntentSeedStore(h.base).create({
        scopeId: h.uid,
        kind: 'idea',
        summary: 'Learn to bake bread',
        source: 'manual',
        sourceRef: null,
        provenance: { proposalId: null, extractor: null, confirmedByUserAt: '2026-10-03T09:00:00.000Z' },
        idempotencyKey: 'fence-772b-seed-patch',
      }, '2026-10-03T09:00:00.000Z');
      await race(h, step, 'seed patch', async () => {
        await assert.rejects(
          createStorageIntentSeedStore(h.storage).patch(h.uid, created.seed.seedId, { summary: 'Bake sourdough' }, '2026-10-03T10:00:00.000Z'),
          AccountUnavailableError,
        );
      });
    });
  });
}
