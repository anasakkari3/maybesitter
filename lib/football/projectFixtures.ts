/**
 * The projection: a followed club's fixtures become commitments, and stay
 * the commitments they became (football fixtures MVP, Task 8).
 *
 * ── Why this reads and writes through participantState ───────────────────
 * `lib/services/commandService.ts` is a process-global, user-less
 * `DomainState` for legacy dev routes; its own header says the launch path
 * for real user data is `lib/services/mobile/participantState.ts`, keyed by
 * uid and durable across Cloud Run instances. A nightly job that wrote a
 * user's commitments into the global state here would pass every test that
 * exercises it in-process and then either throw the first night it ran on
 * Cloud Run (`configureCommandService`'s own guard) or, if that guard were
 * ever loosened, silently mix one user's football fixtures into everybody
 * else's in-memory state. So every commitment write below goes through
 * `applyParticipantCommands(uid, ...)`, and every read through
 * `readParticipantState(uid)`.
 *
 * ── Why `Commitment` carries no `origin` field ────────────────────────────
 * An earlier task added `Commitment.origin` and withdrew it: a sealed
 * annotation corpus checksums the whole serialised commitment, and the field
 * moved that checksum for every commitment, not just this feature's. This
 * module does not reintroduce it. Provenance -- "this commitment came from
 * fixture X, and here is whether it is still following it" -- lives entirely
 * on the `ExternalTaskReference` this module writes alongside the
 * commitment. `ref.linkedCommitmentId` is how a later run knows a commitment
 * is this projection's to update, and it is checked, not inferred from the
 * commitment itself.
 *
 * ── The order inside `projectOneFixture`, and why it cannot be reordered ──
 * `detachedAt` is checked before the non-holding-status branch and before the
 * content-hash comparison, for one reason: a dismissed match whose kickoff
 * later moves has a *different* `contentHash` than the one recorded when it
 * was dismissed, so the hash-equality shortcut ("nothing changed, skip") does
 * not apply to it. If the hash check or the status check ran first, a
 * dismissed-then-rescheduled fixture would fall through to the update branch
 * and the projection would resurrect a commitment the user explicitly said
 * they did not want -- on their calendar, without their say-so, the next
 * time the sync happened to run. A dismissal a sync can undo is not a
 * dismissal. `tests/football/projectFixtures.test.ts`'s
 * `'a dismissed match stays dismissed even when it moves'` and `'a dismissed
 * match stays dismissed through postponement and reschedule'` exist to catch
 * exactly this reordering.
 *
 * ── The one read above is not enough on its own (Task 11's race fix) ──────
 * `ref` above is read once, non-transactionally, before any of branches 2-5
 * run. `task-8-report.md`'s "Fix round 3" section proved that trusting it for
 * the rest of the function is a real TOCTOU window -- a concurrent
 * `dismissFixtureCommitment` (a user tapping "not this match") can set
 * `detachedAt` and drop the linked commitment *after* this read but *before*
 * branch 4 or 5 writes -- and left it unfixed because neither function had a
 * caller yet. `task-11-report.md`'s "Decision 3" section confirmed the race
 * became reachable once the nightly job and the mobile `DELETE` route were
 * wired up, judged it low-severity and self-healing, and deferred the real
 * fix ("a transactional read-modify-write spanning both `projectOneFixture`
 * and `dismissFixtureCommitment`") as its own piece of work.
 *
 * This is that piece of work, on the `projectOneFixture` side (the side that
 * writes an *active* commitment back -- see below for why the other side
 * does not need to change). `createCommitmentForFixtureGuarded` and
 * `updateCommitmentForFixtureGuarded` open their own storage transaction and
 * `tx.get` the ref a *second* time, inside it, immediately before deciding
 * anything -- not the stale `ref` this function read above. Two independent
 * things then make the fix hold:
 *
 *  1. If a dismissal already landed by the time that second read runs, its
 *     `detachedAt` is visible right there and the transaction throws
 *     `FixtureDetachedRaceError` before writing anything -- caught by the
 *     caller and counted as `skipped`.
 *  2. If a dismissal lands *during* the transaction -- after its `tx.get`,
 *     before it commits -- `storageAdapter.ts`'s own contract makes that
 *     window safe for free: both adapters record every path a transaction
 *     reads and refuse to commit if any of them moved, retrying instead (see
 *     `memoryAdapter.ts`'s `readsStillValid`). A `putRef`/
 *     `putRefCarryingForwardDetachment` write to that exact ref path bumps
 *     its version, the in-flight transaction's commit is refused, and it
 *     retries from the top -- where case 1 above catches it.
 *
 * `dismissFixtureCommitment` itself is unchanged and does not need a
 * transaction of its own for this: it already writes the ref *before*
 * dropping the commitment (see that function), so by the time a commitment
 * it dropped is visible to a racing reader, the ref's `detachedAt` is always
 * already visible too -- there is no ordering in which branch 5's `dropped`
 * case can be reached by a dismissal without case 1 or 2 above having caught
 * it first. The `dropped` case therefore still means exactly what it meant
 * before this fix: the postponement return journey (branch 2 of *this*
 * function dropped it), never a dismissal.
 *
 * Branch 2 (dropping a commitment for a fixture that stopped holding time)
 * is not given the same transactional guard -- dropping never resurrects
 * anything a dismissal did not already want dropped, so the only risk left
 * on that path is the ref write re-asserting a stale `detachedAt: null`,
 * which `putRefCarryingForwardDetachment` closes on its own (see that
 * function's header in `externalTaskRefStore.ts`).
 *
 * `tests/football/projectFixtures.test.ts`'s `'a dismissal landing mid-sync
 * is not undone'` exercises both cases above deterministically, via the
 * memory adapter's `setBeforeCommitHookForTests` -- no real concurrency, no
 * timing-dependent flake.
 *
 * ── Which statuses hold time, and which give it back ──────────────────────
 * `cancelled` was the only status Task 8's brief named, but the same
 * argument applies to two more: `postponed` (football-data.org keeps the old
 * `utcDate` on a postponed match until a new one is announced -- so an
 * un-updated postponement is not "no evening blocked", it is "the wrong
 * evening blocked, for a match that is not being played that night") and
 * `finished` (a fixture whose result is already in has nothing left to block
 * time for). All three are treated identically: drop whatever commitment
 * exists for them, create nothing new. `NON_HOLDING_STATUSES` names the set.
 *
 * A postponed match is usually rescheduled later: the provider re-emits the
 * same `providerMatchId`, `status: 'scheduled'`, and a new `kickoffUtc`. By
 * then the ref's `linkedCommitmentId` still points at the commitment the
 * postponement dropped -- and the domain layer correctly refuses to
 * `UpdateCommitment` a dropped one (`stateMachine.ts`'s
 * `ensureCommitmentStatus`; dropped is not in `UpdateCommitment`'s allowed
 * list). That refusal is not a bug to route around with a wider allowed-list
 * -- a dropped commitment is a closed chapter, not a draft waiting to be
 * reopened -- so `projectOneFixture` catches exactly that
 * `InvalidStateTransitionError` and creates a fresh commitment instead,
 * pointing the ref at the new one. See `createCommitmentForFixture` and
 * `tests/football/projectFixtures.test.ts`'s `'a postponed match that is
 * later rescheduled creates a new commitment'`.
 *
 * `ensureCommitmentStatus` excludes three statuses from `UpdateCommitment`,
 * not one, and all three throw the identical `InvalidStateTransitionError`:
 * `dropped` (the postponement case above), `completed` and `archived`. The
 * first fix round's catch treated every instance of that error as "recreate
 * it," which meant a fixture whose commitment the *user* had already
 * completed -- unrelated to any postponement -- would get a second, active
 * commitment the moment the provider corrected an unrelated detail (a
 * kickoff, a venue) and changed the `contentHash`. Branch 5's catch now
 * reads the linked commitment's actual status before deciding: only
 * `dropped` creates a replacement; `completed`/`archived` create nothing and
 * touch nothing; anything else re-throws rather than guessing. See
 * `tests/football/projectFixtures.test.ts`'s `'a completed fixture
 * commitment is not resurrected by a later content change'` and its
 * `archived` counterpart.
 *
 * ── Why the commitment title carries no team name ─────────────────────────
 * `homeTeamName` / `awayTeamName` are stored on the `ExternalTaskReference`,
 * not baked into `commitment.title`. `Commitment.title` is a single string
 * with no language of its own; a title fixed at projection time would still
 * be showing a user their Arabic session's team names after they switched the
 * app to Hebrew, because nothing re-projects a fixture just because somebody
 * changed a setting. The UI layer renders the visible title from the ref's
 * team names, in whichever language is active, at read time. This module's
 * `title` is therefore a fixed, language-neutral placeholder that the domain
 * layer requires (a `Commitment` cannot have an empty title) and that no UI
 * layer is expected to show verbatim.
 */
import { randomUUID } from 'node:crypto';
import type { Fixture, FixtureStatus, FixtureWindow } from '../../src/contracts/v1/fixtureContracts';
import { FIXTURE_BLOCK_MINUTES } from '../../src/contracts/v1/fixtureContracts';
import {
  EXTERNAL_TASK_CONTRACT_VERSION,
  EXTERNAL_TASK_SCHEMA_VERSION,
  type ExternalTaskContentFingerprint,
  type ExternalTaskReference,
} from '../../src/contracts/v1/externalTaskContracts';
import {
  applyCommand as applyDomainCommand,
  InvalidStateTransitionError,
  type Command,
  type Commitment,
  type DomainEvent,
  type DomainState,
  type TimeSpec,
} from '../../src/domain/stateMachine';
import { applyParticipantCommands, loadDomainState, readParticipantState, writeDomainDiff } from '../services/mobile/participantState';
import { readActivityStats, recordActivityEvents, type ActivityStats } from '../services/activity/activityStats';
import { findCollisions, type CollisionWarning } from '../services/timeCollision';
import { getStorage, userDoc, type StorageTransaction } from '../storage';
import type { UserDocument } from '../storage/userDocument';
import { getFollowedClubs } from './followedClubs';
import { clubById } from './clubs';
import { listFixturesForTeam } from './fixtureStore';
import { getRef, listRefs, putRef, putRefCarryingForwardDetachment, refDocPath } from './externalTaskRefStore';

/**
 * How far ahead a projection run looks. A season's worth of fixtures, not a
 * lifetime's.
 *
 * Exported so `lib/football/syncFixtures.ts` (Task 9) can fetch the same span
 * it projects over. If the two windows ever drifted apart, the sync would
 * store fixtures the projection never gets asked to look at, or the
 * projection would query days the sync never fetched -- silently, since
 * both windows compute a valid-looking `FixtureWindow` either way. Sharing
 * the one constant makes that drift impossible to introduce instead of
 * merely easy to avoid.
 */
export const PROJECTION_WINDOW_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * There is no real OAuth connection behind a football fixture -- it is a
 * public feed, not a per-user account link -- so `ExternalTaskIdentity.
 * connectionId` (which the wider external-task contract expects to name a
 * live connection) is this fixed constant rather than a minted id nobody
 * would ever revoke or reconnect.
 */
const FOOTBALL_FEED_CONNECTION_ID = 'football-fixtures-feed';

/**
 * `Commitment.title` may never be empty (see `stateMachine.ts`'s
 * `assertInvariants`), but this module deliberately puts no team name in it
 * -- see the module header. This is what fills that requirement instead.
 */
const FIXTURE_TITLE_PLACEHOLDER = 'Football fixture';

/**
 * `cancelled` counts every drop this run made, not literally every fixture
 * whose `status` was `'cancelled'` -- `postponed` and `finished` drop a
 * commitment the same way and are folded into the same counter. Task 8's
 * brief fixed this shape (`{ created, updated, cancelled, skipped }`) before
 * `postponed`/`finished` were in scope, and giving each status its own
 * counter would be a wire-shape change with no consumer asking for it yet
 * (nothing reads `ProjectionTally` outside this module and its tests). If a
 * future caller needs to tell "the match was called off" apart from "the
 * match will be rescheduled," that is the moment to widen this type -- not
 * before.
 */
export interface ProjectionTally {
  created: number;
  updated: number;
  cancelled: number;
  skipped: number;
}

/**
 * Statuses that give back whatever time they were holding. A commitment that
 * exists for one of these is dropped; one that doesn't is not created. See
 * the module header for why `postponed` and `finished` belong here alongside
 * the `cancelled` status Task 8's brief named on its own.
 */
const NON_HOLDING_STATUSES: ReadonlySet<FixtureStatus> = new Set<FixtureStatus>(['cancelled', 'postponed', 'finished']);

/**
 * The ref shape this module actually stores: an `ExternalTaskReference` plus
 * the two team names the UI layer needs to render a title later. Kept local
 * to this module (and not added to the shared `ExternalTaskReference`
 * contract) because team names are a fact about *this* provider's rows, not
 * something every external-task integration has an opinion on.
 */
export interface FixtureExternalTaskRef extends ExternalTaskReference {
  readonly homeTeamName: string;
  readonly awayTeamName: string;
}

/**
 * The ref's `taskRefId`, which is also the key its document is stored under.
 *
 * `${provider}:${externalId}`, the same rule #417's
 * `normalizeExternalTaskReference` applies to every task provider, so a
 * reader joining refs across providers can rebuild one from the other.
 * `identity.externalId` is the provider's own match id, un-prefixed, for the
 * same reason: #417's contract keeps the provider in `identity.provider` and
 * the vendor's id in `externalId`, and prefixing it here would make this the
 * one provider whose refs read `football-data:football-data:1` under that rule.
 */
function taskRefIdOf(fixture: Fixture): string {
  return `${fixture.provider}:${fixture.providerMatchId}`;
}

function projectionWindow(now: string): FixtureWindow {
  return {
    fromIso: now,
    toIso: new Date(Date.parse(now) + PROJECTION_WINDOW_DAYS * MS_PER_DAY).toISOString(),
  };
}

/**
 * A fixture is a two-hour claim on somebody's evening: `scheduled_event`,
 * `dueAt` at kickoff, `endAt` at kickoff plus `FIXTURE_BLOCK_MINUTES`. Never
 * all-day -- a kickoff time is exactly the fact an all-day commitment refuses
 * to carry.
 */
function timeSpecFor(fixture: Fixture): TimeSpec {
  const endAt = new Date(Date.parse(fixture.kickoffUtc) + FIXTURE_BLOCK_MINUTES * 60_000).toISOString();
  return {
    kind: 'scheduled_event',
    dueAt: fixture.kickoffUtc,
    endAt,
    remindAt: null,
    allDay: false,
    timezone: 'UTC',
  };
}

function fingerprintOf(fixture: Fixture, now: string): ExternalTaskContentFingerprint {
  const taskRefId = taskRefIdOf(fixture);
  return {
    // The fixture's own content hash: comparing it against the ref's stored
    // copy is exactly the "did anything about this match change" check --
    // see fixtureStore.ts's header for why that hash is stable across a
    // no-op nightly rewrite.
    contentHash: fixture.contentHash,
    // Nothing else in this feed can duplicate a match across providers, so
    // this is not doing dedupe work today; it is filled so a future provider
    // sharing this contract has a real value to compare against rather than
    // a hole this one left behind. Deliberately not #417's
    // `title:`/`due:` keys: a fixture commitment's title is a fixed
    // placeholder (see the header), so two different matches on one day would
    // share a title-and-day dedupe hash and read as duplicates of each other.
    dedupeHash: fixture.contentHash,
    fingerprintedAt: now,
    dedupeKeys: [taskRefId],
  };
}

function buildRef(
  uid: string,
  fixture: Fixture,
  commitmentId: string,
  now: string,
): FixtureExternalTaskRef {
  const taskRefId = taskRefIdOf(fixture);
  return {
    version: EXTERNAL_TASK_CONTRACT_VERSION,
    schemaVersion: EXTERNAL_TASK_SCHEMA_VERSION,
    scopeId: uid,
    taskRefId,
    identity: {
      provider: fixture.provider,
      providerIdentity: {
        provider: fixture.provider,
        providerAccountId: null,
        providerSpaceId: null,
        displayName: null,
      },
      connectionId: FOOTBALL_FEED_CONNECTION_ID,
      externalId: fixture.providerMatchId,
      externalUrl: null,
    },
    linkState: 'linked',
    syncState: 'in_sync',
    fingerprint: fingerprintOf(fixture, now),
    conflict: {
      state: 'none',
      detectedAt: null,
      localVersionHash: null,
      remoteVersionHash: null,
      resolution: 'unresolved',
    },
    linkedCommitmentId: commitmentId,
    lastSyncedAt: now,
    detachedAt: null,
    updatedAt: now,
    homeTeamName: fixture.homeTeamName,
    awayTeamName: fixture.awayTeamName,
  };
}

/**
 * Thrown from inside a guarded transaction (see
 * `createCommitmentForFixtureGuarded` and `updateCommitmentForFixtureGuarded`
 * below) when the reference those functions re-read, transactionally, turns
 * out to already be `detachedAt` -- see the module header's "the one read
 * above is not enough on its own" section. Never escapes `projectOneFixture`:
 * both guarded functions catch it and report `'raced'` to their caller,
 * which counts the fixture as `skipped`. An app-level throw from inside
 * `getStorage().runTransaction`'s callback is never retried by either
 * storage adapter (`storageAdapter.ts`'s header: only a version mismatch
 * discovered *after* the callback returns triggers a retry), so this is an
 * immediate abort with nothing written, not a contention retry.
 */
class FixtureDetachedRaceError extends Error {}

/** `state` after running `commands` against it, in order, plus the events they produced. */
function applyCommands(
  state: DomainState,
  commands: readonly Command[],
): { state: DomainState; events: DomainEvent[] } {
  let candidate = state;
  const events: DomainEvent[] = [];
  for (const command of commands) {
    const transition = applyDomainCommand(candidate, command);
    candidate = transition.newState;
    events.push(...transition.events);
  }
  return { state: candidate, events };
}

/**
 * `CreateDraft` immediately followed by `ConfirmCommitment` -- a command
 * list, not a call, because both `createCommitmentForFixtureGuarded` and
 * `updateCommitmentForFixtureGuarded`'s postponement-return-journey branch
 * need to run it against a domain state they already hold inside their own
 * transaction, not a fresh one `applyParticipantCommands` would load again.
 */
function createAndConfirmCommands(commitmentId: string, timeSpec: TimeSpec, now: string): Command[] {
  return [
    {
      type: 'CreateDraft',
      now,
      commitment: {
        id: commitmentId,
        kind: 'task',
        title: FIXTURE_TITLE_PLACEHOLDER,
        // Uncategorised on purpose (#415). The catalog is work, family,
        // health, finance, social and errands; a match somebody watches
        // fits none of them honestly -- `social` would be a guess about
        // whether they watch it alone -- and a wrong category hides the
        // commitment from the filter the user is looking at, while `null`
        // still shows under "All". Stated rather than left to the
        // default so a later change to the default cannot re-file it.
        category: null,
        timeSpec,
      },
    },
    { type: 'ConfirmCommitment', commitmentId, now },
  ];
}

/**
 * Everything a guarded transaction needs to read before it may write
 * anything (`storageAdapter.ts`'s header: every read must precede every
 * write inside one transaction) -- including, this is the fix, a *second*,
 * transactional read of the fixture's own reference. Throws
 * `FixtureDetachedRaceError` immediately if that fresh read is detached,
 * before either caller below decides anything else.
 */
async function readGuardedInputs(
  tx: StorageTransaction,
  uid: string,
  taskRefId: string,
): Promise<{ user: UserDocument | null; before: DomainState; stats: ActivityStats }> {
  const [user, before, stats, freshRef] = await Promise.all([
    tx.get<UserDocument>(userDoc(uid)),
    loadDomainState(tx, uid),
    readActivityStats(tx, uid),
    tx.get<FixtureExternalTaskRef>(refDocPath(uid, taskRefId)),
  ]);
  if (freshRef?.detachedAt) throw new FixtureDetachedRaceError();
  return { user, before, stats };
}

/**
 * `CreateDraft` immediately followed by `ConfirmCommitment`, and the ref
 * pointing at the new commitment, all in the *same* storage transaction as a
 * fresh, transactional re-read of that ref -- see the module header ("the
 * one read above is not enough on its own") for why this replaced a plain
 * `applyParticipantCommands` call followed by a separate `putRef`.
 *
 * ── Why this composes its own transaction instead of calling
 *    `applyParticipantCommands` ─────────────────────────────────────────────
 * `applyParticipantCommands` already opens `getStorage().runTransaction`, and
 * neither storage adapter's lock is re-entrant -- `MemoryStorageAdapter.
 * acquire()` (`memoryAdapter.ts`) awaits its own predecessor in a FIFO queue
 * that only advances once the *current* transaction's callback has returned,
 * so calling it again from inside an already-running transaction would
 * deadlock rather than nest. `commitCaptureConfirmation` in
 * `participantState.ts` is this codebase's established example of folding
 * one more document into an existing transaction instead of nesting a
 * second one (there, a capture proposal; here, the football ref); this
 * function and `updateCommitmentForFixtureGuarded` follow the same shape,
 * composed from the same already-exported pieces (`loadDomainState`,
 * `writeDomainDiff`, `recordActivityEvents`) that function and
 * `applyParticipantCommands` both use.
 *
 * Following the club was the confirmation -- routing every one of a season's
 * ~50 matches through a confirmation queue is the outcome the owner
 * explicitly rejected, unchanged from the original design.
 *
 * Shared by both callers that need a brand-new commitment: the ordinary "no
 * ref yet" path in `projectOneFixture`, and
 * `updateCommitmentForFixtureGuarded`'s "a ref exists but the commitment it
 * links is no longer updatable" path (the postponement return journey -- see
 * the module header).
 */
async function createCommitmentForFixtureGuarded(
  uid: string,
  fixture: Fixture,
  timeSpec: TimeSpec,
  now: string,
): Promise<'created' | 'raced'> {
  const taskRefId = taskRefIdOf(fixture);
  try {
    await getStorage().runTransaction(async (tx) => {
      const { user, before, stats } = await readGuardedInputs(tx, uid, taskRefId);
      const commitmentId = randomUUID();
      const { state: candidate, events } = applyCommands(before, createAndConfirmCommands(commitmentId, timeSpec, now));
      writeDomainDiff(tx, uid, before, candidate, events, user, now);
      recordActivityEvents(tx, uid, stats, events);
      // A full `tx.set`, not a merge: this ref is either brand new (no `ref`
      // existed before `projectOneFixture` even called this function) or is
      // being replaced wholesale for the postponement return journey, and
      // either way `readGuardedInputs` above already confirmed, inside this
      // same transaction, that whatever is currently stored is not detached
      // -- so `detachedAt: null` here is not a guess, it is what this
      // transaction just verified.
      tx.set<FixtureExternalTaskRef>(refDocPath(uid, taskRefId), buildRef(uid, fixture, commitmentId, now));
    });
    return 'created';
  } catch (error) {
    if (error instanceof FixtureDetachedRaceError) return 'raced';
    throw error;
  }
}

type UpdateOutcome = 'updated' | 'recreated' | 'skipped-closed' | 'raced';

/**
 * Branch 5 of `projectOneFixture`, as one storage transaction: a fresh,
 * transactional read of the ref (see the module header), then the same
 * three-way decision `task-8-report.md`'s "Fix round 3" built -- move the
 * linked commitment, recreate it (the postponement return journey), or touch
 * nothing (`completed`/`archived`) -- made against `before` (this
 * transaction's own read of domain state) rather than a second, separately
 * un-transacted `readParticipantState` call made outside the failed
 * transaction the old code used. That is not just tidier: `before` here is
 * guaranteed to be the very state `applyDomainCommand` just threw against,
 * where the old shape read domain state a second time afterward and trusted
 * the two reads to agree.
 *
 * See `createCommitmentForFixtureGuarded`'s header for why this composes its
 * own transaction instead of calling `applyParticipantCommands`.
 */
async function updateCommitmentForFixtureGuarded(
  uid: string,
  fixture: Fixture,
  ref: FixtureExternalTaskRef,
  timeSpec: TimeSpec,
  now: string,
): Promise<UpdateOutcome> {
  const taskRefId = taskRefIdOf(fixture);
  // Branch 5 (the caller) only reaches this function when `ref.linkedCommitmentId`
  // is set.
  const linkedCommitmentId = ref.linkedCommitmentId as string;
  let outcome: UpdateOutcome = 'updated';
  try {
    await getStorage().runTransaction(async (tx) => {
      const { user, before, stats } = await readGuardedInputs(tx, uid, taskRefId);

      let candidate = before;
      let events: DomainEvent[] = [];
      let writeRef: (t: StorageTransaction) => void = () => {};

      // `UpdateCommitment`'s allowed-status list (`stateMachine.ts`'s
      // `ensureCommitmentStatus`) excludes three statuses, not one:
      // `dropped`, `completed` and `archived` all throw the identical
      // `InvalidStateTransitionError`, and the three mean completely
      // different things here. `dropped` is the postponement return
      // journey -- branch 2 of `projectOneFixture` dropped it, the match is
      // back, a fresh commitment is right. `completed` means the user
      // already dealt with this match; `archived` similarly. Neither is
      // "make a new one" -- the product overruling a user's own completion,
      // because a kickoff got corrected by a minute after the final
      // whistle, would be the exact resurrection failure `detachedAt`-first
      // exists to prevent, arriving through a door that doesn't check *why*
      // the commitment was unwritable. So the catch below reads the
      // commitment's actual current status before deciding anything, rather
      // than treating every `InvalidStateTransitionError` here as "recreate
      // it".
      try {
        const applied = applyCommands(before, [
          { type: 'UpdateCommitment', commitmentId: linkedCommitmentId, now, updates: { timeSpec } },
        ]);
        candidate = applied.state;
        events = applied.events;
        outcome = 'updated';
        // A `tx.merge`, not a `tx.set`: only these five fields change, and
        // `detachedAt` is deliberately never one of them -- combined with
        // `readGuardedInputs`' precondition above, this is belt and
        // suspenders. The precondition makes writing over an active
        // dismissal unreachable; the merge shape makes it inexpressible even
        // if the precondition were ever weakened by a future edit.
        writeRef = (t) => t.merge<FixtureExternalTaskRef>(refDocPath(uid, taskRefId), {
          fingerprint: fingerprintOf(fixture, now),
          homeTeamName: fixture.homeTeamName,
          awayTeamName: fixture.awayTeamName,
          lastSyncedAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (!(error instanceof InvalidStateTransitionError)) throw error;

        const linked = before.commitments[linkedCommitmentId];

        if (linked?.status === 'dropped') {
          // The return journey: a postponement dropped this commitment
          // earlier and the match has now come back with a new kickoff.
          // `readGuardedInputs` above already ruled out this being a
          // dismissal wearing the same `dropped` status -- see the module
          // header's "the one read above is not enough on its own" section
          // for why that ordering is guaranteed, not assumed:
          // `dismissFixtureCommitment` always writes the ref *before*
          // dropping the commitment, so a dismissal-caused `dropped` is
          // never visible here without its `detachedAt` having already been
          // visible to `readGuardedInputs` first.
          const commitmentId = randomUUID();
          const applied = applyCommands(candidate, createAndConfirmCommands(commitmentId, timeSpec, now));
          candidate = applied.state;
          events = applied.events;
          outcome = 'recreated';
          writeRef = (t) => t.set<FixtureExternalTaskRef>(refDocPath(uid, taskRefId), buildRef(uid, fixture, commitmentId, now));
        } else if (linked?.status === 'completed' || linked?.status === 'archived') {
          // The user already dealt with this match. Create nothing, touch
          // nothing -- the product has no business handing it back as new
          // work because the provider corrected a detail after the fact.
          // Counted as `skipped`, not `cancelled`/dropped-count: nothing was
          // dropped (the commitment the user closed stays exactly as they
          // left it) and nothing was created, which is what every other
          // no-op branch in this module means by `skipped`.
          outcome = 'skipped-closed';
          return;
        } else {
          // An `InvalidStateTransitionError` this branch did not anticipate
          // -- `linked` missing entirely despite the ref naming it, or some
          // future status `UpdateCommitment` excludes that isn't one of the
          // three above. Re-throw rather than guess: the lesson of the round
          // that added this catch is that an uncaught throw takes the whole
          // run down, and the lesson of that round is that a catch which
          // assumes it knows why is how a run stays up while doing the
          // wrong thing. Absorbing an unanticipated case into "make a new
          // one" (or into "do nothing") would be exactly that -- so this
          // does neither, and lets it surface instead.
          throw error;
        }
      }

      writeDomainDiff(tx, uid, before, candidate, events, user, now);
      recordActivityEvents(tx, uid, stats, events);
      writeRef(tx);
    });
    return outcome;
  } catch (error) {
    if (error instanceof FixtureDetachedRaceError) return 'raced';
    throw error;
  }
}

/**
 * One fixture, projected against whatever ref (if any) already exists for
 * it. The order of the checks below is the whole point -- see the module
 * header before touching it.
 */
async function projectOneFixture(
  uid: string,
  fixture: Fixture,
  now: string,
  tally: ProjectionTally,
): Promise<void> {
  const taskRefId = taskRefIdOf(fixture);
  const ref = await getRef<FixtureExternalTaskRef>(uid, taskRefId);

  // 1. detachedAt FIRST. A dismissed match whose kickoff later moves (or is
  // postponed, then rescheduled) has a *different* `contentHash` than the
  // one recorded when it was dismissed, so it does *not* hit the
  // "unchanged, skip" shortcut below -- it would otherwise fall through to
  // the status or update branches and resurrect a commitment the user
  // explicitly dismissed. See the module header; this ordering is the
  // feature this task exists to build. This is a fast-path optimisation, not
  // the only guard any more: this `ref` was read non-transactionally, before
  // this function did anything else, so it can already be stale by the time
  // branches 4 and 5 below actually decide to write -- see the module
  // header's "the one read above is not enough on its own" section for the
  // transactional re-read that closes that window.
  if (ref?.detachedAt) {
    tally.skipped += 1;
    return;
  }

  // 2. A fixture that no longer holds time (cancelled, postponed pending a
  // new date, or already finished) drops whatever commitment it made, if
  // any -- see the module header for why all three are treated alike. A
  // fixture nobody had projected yet (no ref) arriving already in one of
  // these statuses is not a drop of anything -- there is nothing to drop,
  // and nothing to create either, so it is simply skipped.
  if (NON_HOLDING_STATUSES.has(fixture.status)) {
    if (ref?.linkedCommitmentId) {
      await applyParticipantCommands(uid, [
        { type: 'Drop', commitmentId: ref.linkedCommitmentId, now },
      ]);
      // `putRefCarryingForwardDetachment`, not `putRef`: dropping a
      // commitment never resurrects anything a dismissal did not already
      // want dropped, so this does not need the same-transaction guard the
      // create/update paths below get -- but the ref write still must not
      // re-assert a stale `detachedAt: null` over a dismissal that landed
      // after this function's own `ref` read above. See that function's
      // header in `externalTaskRefStore.ts`.
      await putRefCarryingForwardDetachment<FixtureExternalTaskRef>(uid, {
        ...ref,
        fingerprint: fingerprintOf(fixture, now),
        lastSyncedAt: now,
        updatedAt: now,
      });
      tally.cancelled += 1;
    } else {
      tally.skipped += 1;
    }
    return;
  }

  // 3. Nothing about the fixture changed since the last sync -- see
  // fixtureStore.ts's header for why the nightly job rewrites every fixture
  // it fetches whether or not it changed, and why comparing the hash here
  // (rather than trusting "it was written") is what keeps a quiet night
  // quiet for the user too: no reminder gets rescheduled for a match that
  // didn't move.
  if (ref && ref.fingerprint.contentHash === fixture.contentHash) {
    tally.skipped += 1;
    return;
  }

  const timeSpec = timeSpecFor(fixture);

  // 4. No ref, or a ref with nothing linked yet: create straight to active.
  // `createCommitmentForFixtureGuarded` re-reads the ref transactionally
  // before deciding anything -- see the module header.
  if (!ref || !ref.linkedCommitmentId) {
    const outcome = await createCommitmentForFixtureGuarded(uid, fixture, timeSpec, now);
    tally[outcome === 'raced' ? 'skipped' : 'created'] += 1;
    return;
  }

  // 5. A ref already links a commitment and the hash changed: the kickoff
  // (or some other core fact) moved. `updateCommitmentForFixtureGuarded`
  // re-reads the ref transactionally before deciding anything -- see the
  // module header -- and folds the move-vs-recreate-vs-skip decision
  // `task-8-report.md`'s "Fix round 3" built into that same transaction.
  const outcome = await updateCommitmentForFixtureGuarded(uid, fixture, ref, timeSpec, now);
  switch (outcome) {
    case 'updated':
      tally.updated += 1;
      return;
    case 'recreated':
      tally.created += 1;
      return;
    case 'skipped-closed':
    case 'raced':
      tally.skipped += 1;
      return;
  }
}

/**
 * Projects every fixture for every club `uid` follows, within a
 * `PROJECTION_WINDOW_DAYS`-day window starting at `now`.
 *
 * No ambient clock: `now` is a parameter, not `Date.now()`, so a caller (the
 * nightly job, or a test) controls exactly what instant "the present" means
 * for this run -- see #413 in the brief for why a server-side test pins its
 * instants explicitly rather than trusting a runtime default.
 */
export async function projectFixturesForUser(uid: string, now: string): Promise<ProjectionTally> {
  const tally: ProjectionTally = { created: 0, updated: 0, cancelled: 0, skipped: 0 };

  const clubIds = await getFollowedClubs(uid);
  if (clubIds.length === 0) return tally;

  const window = projectionWindow(now);

  // Merged across every followed club, keyed by the match's own external id.
  // A match between two clubs this user follows both sides of (an "el
  // clasico" they follow both Barcelona and Real Madrid for) would otherwise
  // come back once from each club's query. This is *not* what stands between
  // that and two commitments -- `projectOneFixture`'s own ref lookup already
  // does: the second occurrence would find the ref the first one just wrote,
  // see an unchanged `contentHash`, and skip (verified: temporarily
  // processing each club's fixtures independently, without this merge, still
  // left `tests/football/projectFixtures.test.ts`'s derby test green). What
  // this merge buys instead is not re-running `projectOneFixture` -- and the
  // storage transaction inside it -- a second time for a fixture this run
  // has already handled, which matters more as a followed list grows past
  // two clubs that happen to share a fixture.
  const byExternalId = new Map<string, Fixture>();
  for (const clubId of clubIds) {
    const club = clubById(clubId);
    // setFollowedClubs already refuses an id the curated list does not
    // contain, so this is not a normal path -- it guards a race between an
    // id being followed and the curated list changing under it, not a typo.
    if (!club) continue;
    const fixtures = await listFixturesForTeam(club.providerTeamId, window);
    for (const fixture of fixtures) {
      byExternalId.set(taskRefIdOf(fixture), fixture);
    }
  }

  // Sorted so a run's write order is deterministic rather than depending on
  // followed-club iteration order or `Map` insertion order. `Array.from`,
  // not `[...byExternalId.values()]`: `tsconfig.json` targets `es5` without
  // `downlevelIteration`, so spreading a `Map` iterator needs this form.
  const fixtures = Array.from(byExternalId.values()).sort((a, b) => {
    if (a.kickoffUtc !== b.kickoffUtc) return a.kickoffUtc < b.kickoffUtc ? -1 : 1;
    return a.providerMatchId < b.providerMatchId ? -1 : a.providerMatchId > b.providerMatchId ? 1 : 0;
  });

  for (const fixture of fixtures) {
    await projectOneFixture(uid, fixture, now, tally);
  }

  return tally;
}

/** One row of `listActiveFixtureCommitments`'s answer -- see its own header. */
export interface FixtureCommitmentSummary {
  readonly commitmentId: string;
  readonly homeTeamName: string;
  readonly awayTeamName: string;
  readonly kickoffUtc: string;
  /**
   * Which of this user's *other* commitments this match's two-hour block
   * overlaps, via `findCollisions` (`lib/services/timeCollision.ts`, Task
   * 10) -- the same query the capture-confirm route already runs, not a
   * second collision detector. This is the fourth piece of the owner's own
   * request that module's header names: know about the match, keep work off
   * it, put it on the calendar, and say so if something already landed on
   * top of it anyway. Always an array, never omitted -- a match with
   * nothing on top of it is a fact, not a "did not check".
   */
  readonly collisions: readonly CollisionWarning[];
}

/**
 * This user's currently-active, fixture-linked commitments -- the join the
 * mobile football route (Task 11) serves instead of a `Commitment.origin`
 * field that does not exist (see the module header: it was added and
 * withdrawn, because a sealed annotation corpus checksums the whole
 * serialised commitment).
 *
 * A commitment this projection made is known only by the
 * `ExternalTaskReference` sitting beside it -- `ref.linkedCommitmentId`. So
 * "which of this user's commitments are fixtures, and what should a screen
 * call them" is answered here by joining `listRefs(uid)` (the refs) against
 * `readParticipantState(uid)` (the commitments themselves, for the kickoff
 * time and to confirm the commitment is still the one holding time for that
 * match) -- the same two reads `dismissFixtureCommitment` and
 * `projectOneFixture` already do, not a new index or a denormalised copy.
 *
 * Three kinds of ref are filtered out, deliberately:
 *  - `detachedAt` set: dismissed. Gone from the list is the whole point of
 *    dismissing -- see `dismissFixtureCommitment`.
 *  - `linkedCommitmentId` null: a ref that predates any commitment (should
 *    not happen in practice -- every write path sets it -- but a stale or
 *    hand-edited row must not crash this read).
 *  - the linked commitment is not `active`: `projectOneFixture`'s branch 2
 *    (`cancelled`/`postponed`/`finished`) drops the commitment but leaves the
 *    ref pointing at the now-`dropped` id, and branch 5's `completed`/
 *    `archived` case leaves a closed commitment exactly where the user left
 *    it. None of those is "a match to maybe dismiss" -- there is nothing
 *    left for a dismiss action to do to a commitment that is not currently
 *    holding time.
 *
 * Sorted by kickoff, soonest first -- the order a person actually wants to
 * scan a list of upcoming matches in, and the same key `projectFixturesForUser`
 * itself sorts by.
 */
export async function listActiveFixtureCommitments(uid: string): Promise<readonly FixtureCommitmentSummary[]> {
  const refs = await listRefs<FixtureExternalTaskRef>(uid);
  const candidates = refs.filter((ref) => !ref.detachedAt && ref.linkedCommitmentId);
  if (candidates.length === 0) return [];

  const state = await readParticipantState(uid);
  const allCommitments: Commitment[] = Object.values(state.commitments);
  const summaries: FixtureCommitmentSummary[] = [];
  for (const ref of candidates) {
    const commitment = state.commitments[ref.linkedCommitmentId!];
    if (!commitment || commitment.status !== 'active') continue;
    const dueAt = commitment.timeSpec.kind === 'scheduled_event' ? commitment.timeSpec.dueAt : null;
    // Every fixture commitment is created with a `scheduled_event` timeSpec
    // (see `timeSpecFor`) and `UpdateCommitment` in branch 5 only ever moves
    // that same field -- so `dueAt` missing here would mean some other code
    // path rewrote this commitment's time shape entirely. Skipped rather
    // than thrown: a screen listing matches should not 500 because one row
    // turned out to be inconsistent.
    if (!dueAt) continue;
    const others = allCommitments.filter((candidate) => candidate.id !== commitment.id);
    const collisions = findCollisions({ dueAt, endAt: commitment.timeSpec.endAt }, others);
    summaries.push({
      commitmentId: ref.linkedCommitmentId!,
      homeTeamName: ref.homeTeamName,
      awayTeamName: ref.awayTeamName,
      kickoffUtc: dueAt,
      collisions,
    });
  }

  summaries.sort((a, b) => (a.kickoffUtc < b.kickoffUtc ? -1 : a.kickoffUtc > b.kickoffUtc ? 1 : 0));
  return summaries;
}

/**
 * A user says "not this match." The ref is marked `detachedAt` forever
 * (never recreated by a later projection run -- see the module header) and
 * the commitment it made, if any, is dropped the same way a cancelled
 * fixture's commitment is dropped.
 *
 * Looks the ref up by `linkedCommitmentId` because the caller only has the
 * commitment id (what the user tapped "dismiss" on) -- see
 * `externalTaskRefStore.ts`'s `listRefs` header for why this is a linear
 * scan rather than an index.
 */
export async function dismissFixtureCommitment(
  uid: string,
  commitmentId: string,
  now: string,
): Promise<void> {
  const refs = await listRefs<FixtureExternalTaskRef>(uid);
  const ref = refs.find((candidate) => candidate.linkedCommitmentId === commitmentId);
  if (!ref) {
    throw new Error(`no external task reference links commitment ${commitmentId}`);
  }

  await putRef<FixtureExternalTaskRef>(uid, {
    ...ref,
    linkState: 'detached',
    detachedAt: now,
    updatedAt: now,
  });

  const state = await readParticipantState(uid);
  const commitment = state.commitments[commitmentId];
  // Already gone (dropped by an earlier dismiss, or by a cancellation that
  // raced it) -- marking the ref detached above is still correct and is not
  // undone; there is simply nothing left for a Drop command to do.
  if (commitment && commitment.status !== 'dropped') {
    await applyParticipantCommands(uid, [{ type: 'Drop', commitmentId, now }]);
  }
}
