/**
 * The daily plan proposes; it never edits what the user committed to
 * (UC-3.10a, #194).
 *
 * `PLANNING_PERSISTENCE_POLICY` says `planCanPersist: false`,
 * `adapterOwnsCanonicalWrites: true` and `originalCommitmentRemainsCanonical:
 * true`. The adapter this issue adds is allowed to persist a *proposal about
 * time*; it is not allowed to touch a commitment. That is the acceptance
 * criterion "no code path here writes to `commitments`", and it is checked
 * twice, because either check alone is weak:
 *
 *  - **Statically**, by reading the source of every file this issue owns. It
 *    catches a writer that no test happens to reach — the route nobody wrote a
 *    case for, the branch behind a feature flag.
 *  - **Behaviourally**, by recording every path written to durable storage
 *    while a plan is built, accepted, edited, regenerated and dismissed, and
 *    asserting that none of them is inside a `commitments` collection. It
 *    catches a write that goes through a helper the grep does not know the name
 *    of, which is exactly the failure a name list cannot see.
 *
 * The last guard pins the two *pure* modules clock-free. `inputDigest` being
 * stable across two runs is an acceptance criterion, and a single `Date.now()`
 * in the mapping would break it in a way no behavioural test would reliably
 * catch — the same reasoning `tests/planning/planningBoundaries.test.ts` gives
 * for pinning `lib/planning/**`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter, StorageTransaction } from '../../lib/storage/storageAdapter.ts';
import { userCol, userDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import {
  acceptPlan,
  dismissPlan,
  editPlan,
  regeneratePlan,
} from '../../lib/services/dailyPlan/planActions.ts';
import { readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serviceDir = join(repoRoot, 'lib', 'services', 'dailyPlan');
const routeDir = join(repoRoot, 'src', 'app', 'api', 'mobile', 'plans');
const settingsRoute = join(repoRoot, 'src', 'app', 'api', 'mobile', 'settings', 'plan', 'route.ts');
const jobRoute = join(repoRoot, 'src', 'app', 'api', 'internal', 'jobs', 'daily-plan', 'route.ts');

/**
 * The source with its comments removed.
 *
 * Both greps below are about what the code *does*, and this file's own modules
 * explain at length why they do not write commitments — naming
 * `applyParticipantCommand` and the `commitments` collection while saying they
 * are not reached. A check that read the prose would have been satisfied by
 * paraphrasing the prose, which is the worst kind of passing test. Strings are
 * deliberately kept: `'commitments'` in a string literal is exactly the
 * hand-written path this is looking for.
 */
function codeOf(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      out += char;
      if (char === '\\') { out += source[index + 1] ?? ''; index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') { quote = char; out += char; continue; }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
}

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

const OWNED = [...filesUnder(serviceDir), ...filesUnder(routeDir), settingsRoute, jobRoute];

/* ── Statically: nothing here can write a commitment ─────────────── */

/**
 * Every module that writes a commitment, and every function that does.
 *
 * Names rather than a pattern, because "writes a commitment" is not a shape.
 * `loadDomainState` is deliberately absent: reading the commitments a plan is
 * built from is the whole point, and a rule that forbade the read would forbid
 * the feature.
 */
const COMMITMENT_WRITERS = [
  'commandService',
  'canonicalPersistence',
  'deterministicStateGateway',
  'captureBoundaryService',
  'agendaActionService',
  'commitmentService',
  'applyParticipantCommand',
  'applyParticipantCommands',
  'persistParticipantState',
  'commitCaptureConfirmation',
  'writeDomainDiff',
  'applyCommand',
  'completeCommitment',
  'postponeCommitment',
  'dropCommitment',
  'patchCommitment',
] as const;

test('the owned files exist and are enumerated', () => {
  assert.ok(OWNED.length >= 10, `scanned too few files; this check would be vacuous:\n${OWNED.join('\n')}`);
  for (const file of OWNED) assert.ok(statSync(file).isFile(), `${file} is missing`);
});

test('no file in this feature reaches a commitment writer', () => {
  const offenders: string[] = [];
  for (const file of OWNED) {
    const source = codeOf(readFileSync(file, 'utf8'));
    for (const writer of COMMITMENT_WRITERS) {
      if (new RegExp(`\\b${writer}\\b`).test(source)) {
        offenders.push(`${relative(repoRoot, file)}: ${writer}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a daily-plan module can write canonical commitment state');
});

test('no file in this feature names the commitments collection', () => {
  const offenders: string[] = [];
  for (const file of OWNED) {
    const source = codeOf(readFileSync(file, 'utf8'));
    if (/\bCOMMITMENTS\b/.test(source) || /userCol\([^)]*'commitments'/.test(source) || /['"`]commitments['"`]/.test(source)) {
      offenders.push(relative(repoRoot, file));
    }
  }
  assert.deepEqual(offenders, [], 'a daily-plan module addresses the commitments collection directly');
});

test('the two pure modules read no clock, so the input digest is reproducible', () => {
  for (const name of ['buildDailyPlan.ts', 'explanationValidator.ts']) {
    const source = codeOf(readFileSync(join(serviceDir, name), 'utf8'));
    for (const pattern of [/\bDate\.now\s*\(/, /\bnew Date\s*\(\s*\)/, /\bMath\.random\s*\(/]) {
      assert.doesNotMatch(source, pattern, `${name} reads a clock or a random source`);
    }
  }
});

/* ── Behaviourally: nothing written is inside a commitments tree ── */

const UID = 'user_boundary_1';
const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-15';
const MORNING = new Date('2026-09-15T06:00:00.000Z');

/** A storage adapter that records every path any write touches, transactions included. */
function recording(inner: StorageAdapter): { adapter: StorageAdapter; writes: string[] } {
  const writes: string[] = [];
  const wrapTx = (tx: StorageTransaction): StorageTransaction => ({
    get: (path) => tx.get(path),
    list: (path, options) => tx.list(path, options),
    listGroup: (id, options) => tx.listGroup(id, options),
    set: (path, value) => { writes.push(path); tx.set(path, value); },
    merge: (path, value) => { writes.push(path); tx.merge(path, value); },
    create: (path, value) => { writes.push(path); tx.create(path, value); },
    delete: (path) => { writes.push(path); tx.delete(path); },
  });
  const adapter: StorageAdapter = {
    get: (path) => inner.get(path),
    list: (path, options) => inner.list(path, options),
    listGroup: (id, options) => inner.listGroup(id, options),
    set: async (path, value) => { writes.push(path); return inner.set(path, value); },
    delete: async (path) => { writes.push(path); return inner.delete(path); },
    deleteTree: async (path) => { writes.push(path); return inner.deleteTree(path); },
    runTransaction: (fn) => inner.runTransaction((tx) => fn(wrapTx(tx))),
  };
  return { adapter, writes };
}

function seedState() {
  let state = createEmptyDomainState();
  const titles = ['Write the summary', 'Call the bank', 'Book the train'];
  for (let index = 0; index < titles.length; index += 1) {
    const id = `cmt_${index}`;
    const title = titles[index]!;
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  }
  return state;
}

test('a whole plan lifecycle writes nothing into any commitments collection', async () => {
  const inner = createMemoryStorage();
  setStorageForTests(inner);
  try {
    await persistParticipantState(UID, seedState());
    const user = await inner.get<Record<string, unknown>>(userDoc(UID));
    await inner.set(userDoc(UID), { ...(user ?? {}), timezone: TZ, locale: 'en' });

    const before = await inner.list<Record<string, unknown>>(userCol(UID, 'commitments'));
    assert.equal(before.length, 3, 'the fixture did not seed three commitments');

    // Everything after this point is recorded.
    const { adapter, writes } = recording(inner);
    const deps = { storage: adapter, now: () => MORNING };

    await savePlanSettings(UID, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), deps);
    const claim = await claimDueDelivery(UID, MORNING, deps);
    assert.ok(claim, 'the account was not claimable');
    await buildAndStoreDailyPlan(claim, deps);

    const stored = await readStoredPlan(UID, DATE, adapter);
    await editPlan(UID, DATE, {
      moves: [{ itemId: stored!.plan.scheduled[0]!.itemId, startsAt: '2026-09-15T12:00:00.000Z', endsAt: '2026-09-15T12:00:00.000Z' }],
      removals: [],
    }, deps);
    await acceptPlan(UID, DATE, deps);
    await regeneratePlan(UID, DATE, deps);
    await dismissPlan(UID, DATE, deps);

    assert.ok(writes.length >= 6, `too few writes recorded (${writes.length}); this check would be vacuous`);
    assert.deepEqual(
      writes.filter((path) => path.includes('/commitments')),
      [],
      'the daily plan wrote into a commitments collection',
    );
    // And the wider rule: nothing outside the user document, the plan and its
    // ledger was written at all — plus the one activity counter accepting a
    // plan advances in the same commit as its ledger entry (UC-3.15, #201),
    // which is a forward-only tally and names no commitment.
    assert.deepEqual(
      writes.filter((path) => !new RegExp(`^users/${UID}((/(plans|planEvents)/[^/]+)|/stats/activity)?$`).test(path)),
      [],
      'the daily plan wrote somewhere this feature does not own',
    );

    assert.deepEqual(
      await inner.list<Record<string, unknown>>(userCol(UID, 'commitments')),
      before,
      'a commitment changed while the plan was being built, edited and regenerated',
    );
  } finally {
    resetStorageForTests();
  }
});
