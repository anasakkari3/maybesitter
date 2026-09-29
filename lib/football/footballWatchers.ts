/**
 * Following a club, as a watcher (closure CL7, «تابعلي هذا الإشي»).
 *
 * ── One follow, one watcher ─────────────────────────────────────────────
 * A club the user follows and a football watcher over that club are the same
 * fact seen from two screens: the watcher builder creates both, Settings →
 * Football's follow list reconciles to both, and "Stop following" removes
 * both. The follow list is what the sync fetches and the projection turns into
 * match commitments (`projectFixtures.ts`); the watcher is what notices a
 * known match moving and routes that through the one watcher engine
 * (`lib/watchers/watcherEngine.ts`, `footballTeamObserver`).
 *
 * This module lives under `lib/football`, not `lib/watchers`, on purpose:
 * following a club projects commitments, and the watcher modules are held by
 * `tests/watchers/watcherSafety.test.ts` to an import list that cannot reach a
 * commitment writer. The routes call this; the engine never does.
 *
 * ── Confirming the follow is confirming the matches ─────────────────────
 * The builder shows what following does before the user confirms it — the
 * club's matches go on the calendar as two-hour blocks, any one of which can
 * be dropped — and nothing is written until that confirm. A per-match
 * confirmation queue is the outcome the owner rejected for this feature
 * (`projectFixtures.ts`, `createCommitmentForFixtureGuarded`), so the follow
 * stays the one confirmation.
 *
 * ── Only when the provider key exists ───────────────────────────────────
 * Without `FOOTBALL_DATA_API_KEY` nothing would ever be fetched, so a follow
 * would be a promise the server cannot keep. Creating a football watcher then
 * answers `provider_not_configured`, and `GET /api/mobile/football` reports
 * `providerConfigured: false` so the app does not offer the source at all.
 */
import {
  FOOTBALL_TEAM_SIGNAL_KIND,
  FOOTBALL_WATCHER_PROVIDER,
} from '../../src/contracts/v1/fixtureContracts';
import type { WatcherEffect, WatcherSourceRef } from '../../src/contracts/v1/watcherContracts';
import { WatcherValidationError } from '../watchers/watcherApi';
import { createWatcherStore, type NewWatcherInput, type StoredWatcher } from '../watchers/watcherStore';
import { clubById, type ClubLanguage } from './clubs';
import { getFollowedClubs, setFollowedClubs } from './followedClubs';
import { projectFixturesForUser, titleLanguageFor } from './projectFixtures';

/**
 * Whether this server can fetch match data at all. Read from the environment
 * on every call (the key reaches Cloud Run through `--set-secrets`), so a key
 * added later takes effect on the next revision without a code change.
 */
export function footballProviderConfigured(env?: { FOOTBALL_DATA_API_KEY?: string }): boolean {
  const key = (env ?? process.env).FOOTBALL_DATA_API_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}

export class FootballNotConfiguredError extends Error {
  readonly reason = 'provider_not_configured';
  constructor() {
    super('match data is not set up on this server');
    this.name = 'FootballNotConfiguredError';
  }
}

/**
 * What a football watcher may do when a known match moves. The matches
 * themselves are already on the calendar (the projection moves them), so the
 * two effects that mean something are "reconsider my plan" and "tell me".
 * A proposal or a context update over a club would be an artifact nothing
 * in the app reads.
 */
export const FOOTBALL_WATCHER_EFFECTS: readonly WatcherEffect[] = Object.freeze(['replan_if_impacted', 'notify']);

/**
 * Keyed on the signal kind alone: a per-match `fixture` watcher (the engine's
 * older football observer) shares the provider name and keeps its own rules.
 */
export function isFootballWatcherSource(source: Pick<WatcherSourceRef, 'signalKind'>): boolean {
  return source.signalKind === FOOTBALL_TEAM_SIGNAL_KIND;
}

export function assertFootballWatcherEffect(effect: WatcherEffect): void {
  if (!FOOTBALL_WATCHER_EFFECTS.includes(effect)) {
    throw new WatcherValidationError('a football watcher can reconsider the plan or notify', 'invalid_effect');
  }
}

/** The rules a football watcher's body must meet on top of `parseNewWatcher`'s. */
export function assertFootballWatcherInput(input: NewWatcherInput): void {
  const { source } = input;
  if (source.provider !== FOOTBALL_WATCHER_PROVIDER || source.signalKind !== FOOTBALL_TEAM_SIGNAL_KIND) {
    throw new WatcherValidationError(
      `a football watcher is provider "${FOOTBALL_WATCHER_PROVIDER}" with signal "${FOOTBALL_TEAM_SIGNAL_KIND}"`,
      'invalid_football_source',
    );
  }
  if (source.connectionId !== null) {
    throw new WatcherValidationError('match data needs no connection', 'invalid_connection_id');
  }
  if (!clubById(source.subjectRef)) {
    throw new WatcherValidationError('not a club this app follows', 'unknown_club');
  }
  if (input.condition.kind !== 'digest_changed') {
    throw new WatcherValidationError('a football watcher watches for match changes', 'invalid_condition');
  }
  assertFootballWatcherEffect(input.effect);
}

function isWatcherFor(stored: StoredWatcher, clubId: string): boolean {
  return stored.definition.source.signalKind === FOOTBALL_TEAM_SIGNAL_KIND
    && stored.definition.source.subjectRef === clubId;
}

async function footballWatchers(uid: string): Promise<readonly StoredWatcher[]> {
  return (await createWatcherStore(uid).list())
    .filter((stored) => stored.definition.source.signalKind === FOOTBALL_TEAM_SIGNAL_KIND);
}

export interface FollowOptions {
  readonly env?: { FOOTBALL_DATA_API_KEY?: string };
}

/**
 * "Follow this club for me": the club joins the follow list, a watcher over
 * it is created, and the club's matches already in the store are projected
 * straight away. A club nobody followed before has none stored yet; the
 * per-minute poll (`pollFollowedClubs`) fetches it within a minute or two.
 *
 * Idempotent: following a club that already has a watcher returns that
 * watcher and creates nothing, so a double tap is one follow.
 */
export async function followClubWithWatcher(
  uid: string,
  input: NewWatcherInput,
  now: string,
  options: FollowOptions = {},
): Promise<{ watcher: StoredWatcher; created: boolean }> {
  if (!footballProviderConfigured(options.env)) throw new FootballNotConfiguredError();
  assertFootballWatcherInput(input);
  const clubId = input.source.subjectRef;

  const existing = (await footballWatchers(uid)).find((stored) => isWatcherFor(stored, clubId));
  if (existing) return { watcher: existing, created: false };

  const followed = await getFollowedClubs(uid);
  if (!followed.includes(clubId)) await setFollowedClubs(uid, [...followed, clubId], now);
  const watcher = await createWatcherStore(uid).create(input, now);
  await projectFixturesForUser(uid, now);
  return { watcher, created: true };
}

/**
 * After a football watcher was deleted: stop following its club (unless
 * another watcher still follows it) and re-project, which drops the club's
 * matches still ahead (`releaseUnfollowedFixtures`) — "Stop following"
 * takes the matches it put on the calendar with it.
 */
export async function releaseClubAfterWatcherRemoved(uid: string, removed: StoredWatcher, now: string): Promise<void> {
  if (removed.definition.source.signalKind !== FOOTBALL_TEAM_SIGNAL_KIND) return;
  const clubId = removed.definition.source.subjectRef;
  if ((await footballWatchers(uid)).some((stored) => isWatcherFor(stored, clubId))) return;
  const followed = await getFollowedClubs(uid);
  if (followed.includes(clubId)) {
    await setFollowedClubs(uid, followed.filter((id) => id !== clubId), now);
  }
  await projectFixturesForUser(uid, now);
}

export interface ReconcileOptions {
  /** The app's current language; absent means the account's (`titleLanguageFor`). */
  readonly language?: ClubLanguage;
  /**
   * Whether a followed club without a watcher gets one. False without the
   * provider key: a watcher then would say LIVE over a club nothing fetches.
   */
  readonly createMissing?: boolean;
}

/**
 * Settings → Football saves a whole follow list; this makes the watchers match
 * it — one per followed club, none for a club no longer followed — so the
 * watcher screen and the follow list can never disagree about what is being
 * followed. The per-minute poll runs it too, for the followers of every club
 * it refreshes, so a follow saved before football became a watcher (or before
 * the key existed) gets its watcher the first time its club is fetched.
 */
export async function reconcileFootballWatchers(
  uid: string,
  followedClubIds: readonly string[],
  now: string,
  options: ReconcileOptions = {},
): Promise<void> {
  const store = createWatcherStore(uid);
  const current = await footballWatchers(uid);
  const wanted = new Set(followedClubIds);
  for (const stored of current) {
    if (!wanted.has(stored.definition.source.subjectRef)) await store.remove(stored.definition.watcherId);
  }
  if (options.createMissing === false) return;
  const missing = followedClubIds.filter((clubId) => !current.some((stored) => isWatcherFor(stored, clubId)));
  if (missing.length === 0) return;
  const language = await titleLanguageFor(uid, options.language);
  for (const clubId of missing) {
    const club = clubById(clubId);
    if (!club) continue;
    await store.create({
      enabled: true,
      label: club.names[language],
      source: {
        provider: FOOTBALL_WATCHER_PROVIDER,
        connectionId: null,
        signalKind: FOOTBALL_TEAM_SIGNAL_KIND,
        subjectRef: clubId,
      },
      condition: { kind: 'digest_changed' },
      effect: 'replan_if_impacted',
      createdBy: 'user',
    }, now);
  }
}
