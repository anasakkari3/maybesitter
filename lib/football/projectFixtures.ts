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
 * `detachedAt` is checked before the cancelled-status branch and before the
 * content-hash comparison, for one reason: a dismissed match whose kickoff
 * later moves has a *different* `contentHash` than the one recorded when it
 * was dismissed, so the hash-equality shortcut ("nothing changed, skip") does
 * not apply to it. If the hash check or the cancelled check ran first, a
 * dismissed-then-rescheduled fixture would fall through to the update branch
 * and the projection would resurrect a commitment the user explicitly said
 * they did not want -- on their calendar, without their say-so, the next
 * time the sync happened to run. A dismissal a sync can undo is not a
 * dismissal. `tests/football/projectFixtures.test.ts`'s
 * `'a dismissed match stays dismissed even when it moves'` exists to catch
 * exactly this reordering.
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
import type { Fixture, FixtureWindow } from '../../src/contracts/v1/fixtureContracts';
import { FIXTURE_BLOCK_MINUTES } from '../../src/contracts/v1/fixtureContracts';
import {
  EXTERNAL_TASK_CONTRACT_VERSION,
  EXTERNAL_TASK_SCHEMA_VERSION,
  type ExternalTaskContentFingerprint,
  type ExternalTaskReference,
} from '../../src/contracts/v1/externalTaskContracts';
import type { Command, TimeSpec } from '../../src/domain/stateMachine';
import { applyParticipantCommands, readParticipantState } from '../services/mobile/participantState';
import { getFollowedClubs } from './followedClubs';
import { clubById } from './clubs';
import { listFixturesForTeam } from './fixtureStore';
import { getRef, listRefs, putRef } from './externalTaskRefStore';

/** How far ahead a projection run looks. A season's worth of fixtures, not a lifetime's. */
const PROJECTION_WINDOW_DAYS = 60;
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

export interface ProjectionTally {
  created: number;
  updated: number;
  cancelled: number;
  skipped: number;
}

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

function externalIdOf(fixture: Fixture): string {
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
  const externalId = externalIdOf(fixture);
  return {
    // The fixture's own content hash: comparing it against the ref's stored
    // copy is exactly the "did anything about this match change" check --
    // see fixtureStore.ts's header for why that hash is stable across a
    // no-op nightly rewrite.
    contentHash: fixture.contentHash,
    // Nothing else in this feed can duplicate a match across providers, so
    // this is not doing dedupe work today; it is filled so a future provider
    // sharing this contract has a real value to compare against rather than
    // a hole this one left behind.
    dedupeHash: fixture.contentHash,
    fingerprintedAt: now,
    dedupeKeys: [externalId],
  };
}

function buildRef(
  uid: string,
  fixture: Fixture,
  commitmentId: string,
  now: string,
): FixtureExternalTaskRef {
  const externalId = externalIdOf(fixture);
  return {
    version: EXTERNAL_TASK_CONTRACT_VERSION,
    schemaVersion: EXTERNAL_TASK_SCHEMA_VERSION,
    scopeId: uid,
    taskRefId: externalId,
    identity: {
      provider: fixture.provider,
      providerIdentity: {
        provider: fixture.provider,
        providerAccountId: null,
        providerSpaceId: null,
        displayName: null,
      },
      connectionId: FOOTBALL_FEED_CONNECTION_ID,
      externalId,
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
  const externalId = externalIdOf(fixture);
  const ref = await getRef<FixtureExternalTaskRef>(uid, externalId);

  // 1. detachedAt FIRST. A dismissed match whose kickoff later moves has a
  // changed contentHash, so it does *not* hit the "unchanged, skip" shortcut
  // below -- it would otherwise fall all the way through to the update
  // branch and resurrect a commitment the user explicitly dismissed. See the
  // module header; this ordering is the feature this task exists to build.
  if (ref?.detachedAt) {
    tally.skipped += 1;
    return;
  }

  // 2. A cancelled match drops whatever commitment it made, if any. A
  // cancellation for a fixture nobody had projected yet (no ref) is not a
  // drop of anything -- there is nothing to drop, and nothing to create
  // either, so it is simply skipped.
  if (fixture.status === 'cancelled') {
    if (ref?.linkedCommitmentId) {
      await applyParticipantCommands(uid, [
        { type: 'Drop', commitmentId: ref.linkedCommitmentId, now },
      ]);
      await putRef<FixtureExternalTaskRef>(uid, {
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
  // Following the club was the confirmation -- routing every one of a
  // season's ~50 matches through a confirmation queue is the outcome the
  // owner explicitly rejected, so this is `CreateDraft` immediately followed
  // by `ConfirmCommitment`, applied together in one transaction.
  if (!ref || !ref.linkedCommitmentId) {
    const commitmentId = randomUUID();
    const commands: Command[] = [
      {
        type: 'CreateDraft',
        now,
        commitment: {
          id: commitmentId,
          kind: 'task',
          title: FIXTURE_TITLE_PLACEHOLDER,
          timeSpec,
        },
      },
      { type: 'ConfirmCommitment', commitmentId, now },
    ];
    await applyParticipantCommands(uid, commands);
    await putRef<FixtureExternalTaskRef>(uid, buildRef(uid, fixture, commitmentId, now));
    tally.created += 1;
    return;
  }

  // 5. A ref already links a commitment and the hash changed: the kickoff
  // (or some other core fact) moved. Move the same commitment rather than
  // creating a second one for the same match.
  await applyParticipantCommands(uid, [
    { type: 'UpdateCommitment', commitmentId: ref.linkedCommitmentId, now, updates: { timeSpec } },
  ]);
  await putRef<FixtureExternalTaskRef>(uid, {
    ...ref,
    fingerprint: fingerprintOf(fixture, now),
    homeTeamName: fixture.homeTeamName,
    awayTeamName: fixture.awayTeamName,
    lastSyncedAt: now,
    updatedAt: now,
  });
  tally.updated += 1;
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
      byExternalId.set(externalIdOf(fixture), fixture);
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
