import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../lib/services/mobile/response';
import { listClubs, type ClubLanguage } from '../../../../../lib/football/clubs';
import { setUserLocale } from '../../../../../lib/storage/userLocale';

const TITLE_LANGUAGES: readonly ClubLanguage[] = ['ar', 'he', 'en'];
import { UnknownClubError, getFollowedClubs, setFollowedClubs } from '../../../../../lib/football/followedClubs';
import { listActiveFixtureCommitments, projectFixturesForUser } from '../../../../../lib/football/projectFixtures';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../lib/net/requestBody';
import { footballProviderConfigured, reconcileFootballWatchers } from '../../../../../lib/football/footballWatchers';

export const dynamic = 'force-dynamic';

/**
 * "If I love Barcelona, I want to see all of the games" -- the screen this
 * route serves (football fixtures MVP, Task 11).
 *
 * ── Why `fixtures` rides along with `clubs`/`followedClubIds` ────────────
 * `Commitment.origin` does not exist (an earlier task added and withdrew it
 * -- see `lib/football/projectFixtures.ts`'s header), so there is no field on
 * a commitment a client can read to ask "is this one of mine, from the feed".
 * `listActiveFixtureCommitments` answers that by joining this user's own
 * `ExternalTaskReference` rows against their own domain state -- the same
 * join `dismissFixtureCommitment` does -- and this route returns the result
 * alongside the follow list so the client never has to ask a second route
 * (or read a field that isn't there) to know which commitments it may offer
 * a dismiss action on. See `tests/football/footballRoute.test.ts` and
 * `task-11-report.md` for the fuller account of this decision.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const [followedClubIds, fixtures] = await Promise.all([
    getFollowedClubs(user.uid),
    listActiveFixtureCommitments(user.uid),
  ]);
  // `providerConfigured` (closure CL7): whether this server holds the match
  // data key. Without it nothing is ever fetched, so the app hides the
  // football source everywhere instead of offering a follow that never fills.
  return Response.json({
    success: true, providerConfigured: footballProviderConfigured(), clubs: listClubs(), followedClubIds, fixtures,
  });
}

/**
 * Replaces the whole follow list, then projects immediately.
 *
 * ── Why this calls `projectFixturesForUser` inline, synchronously ────────
 * The nightly job (`lib/jobs/internalJobs.ts`'s `runFootballSyncJob`) is the
 * only other caller of `projectFixturesForUser`, and it runs once a day. A
 * user who follows Barcelona and sees an empty screen until tomorrow morning
 * has no way to tell that apart from the feature being broken -- so saving a
 * follow projects immediately against whatever fixtures are *already* in the
 * store (this call fetches nothing from the provider; that is the nightly
 * sync's job, budgeted and rate-limited in `syncFixtures.ts` in a way a
 * 15-second mobile request timeout could not survive). For a club somebody
 * else already follows, the store already has its fixtures and the first
 * match appears in this same response. For a club nobody has ever followed
 * before, this call still runs (and does nothing) rather than being skipped
 * -- the next nightly sync fetches it, and the projection picks it up then
 * without needing a second code path.
 *
 * ── The race this makes reachable ─────────────────────────────────────────
 * `task-8-report.md`'s "Fix round 3" section flags a real, unfixed TOCTOU
 * race between `projectFixturesForUser` and `dismissFixtureCommitment`, and
 * says whoever wires either one to a caller that can run concurrently with
 * the other should read it first. This route is `projectFixturesForUser`'s
 * first per-request caller; `fixtures/[commitmentId]/route.ts` is
 * `dismissFixtureCommitment`'s. See `task-11-report.md` for the worst-case
 * outcome and why it is not fixed here.
 */
export async function PUT(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: { clubIds?: unknown; locale?: unknown };
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  if (!Array.isArray(body.clubIds) || !body.clubIds.every((id) => typeof id === 'string')) {
    return mobileError('clubIds must be an array of strings');
  }
  // Optional: the app's current language, used to title the matches this
  // save projects (see `projectFixtures.ts`'s header). Absent means "use
  // what the account already says"; anything else is refused, not guessed.
  if (body.locale !== undefined && !TITLE_LANGUAGES.includes(body.locale as ClubLanguage)) {
    return mobileError(`locale must be one of ${TITLE_LANGUAGES.join(', ')}`);
  }
  const language = body.locale as ClubLanguage | undefined;

  // Without the match data key nothing is ever fetched, so a club added here
  // would be a follow the server cannot keep: refused, nothing written. A
  // list that only keeps or drops clubs is still saved — stopping a follow
  // never needs the key (closure CL7).
  const configured = footballProviderConfigured();
  if (!configured) {
    const current = new Set(await getFollowedClubs(user.uid));
    if ((body.clubIds as string[]).some((clubId) => !current.has(clubId))) {
      return Response.json(
        { success: false, error: 'match data is not set up on this server', reason: 'provider_not_configured' },
        { status: 409 },
      );
    }
  }

  const now = new Date().toISOString();
  let followedClubIds: readonly string[];
  try {
    followedClubIds = await setFollowedClubs(user.uid, body.clubIds as string[], now);
  } catch (error) {
    // `setFollowedClubs` refuses an unknown club id before anything is
    // written -- see its own header for why that is refused here rather than
    // becoming a silent permanent no-op in every future sync. That is the
    // caller's mistake (400); anything else is the server failing to write,
    // said as such and without the storage error's own text.
    if (error instanceof UnknownClubError) return mobileError(error.message, 400);
    console.error('[football] saving followed clubs failed', error instanceof Error ? error.message : 'unknown error');
    return Response.json(
      { success: false, error: 'followed clubs could not be saved', reason: 'follow_not_saved' },
      { status: 503 },
    );
  }

  // ── Everything below is after the follow is saved ─────────────────────
  // Live P1 (2026-09-29): the fixtures-by-team query had no composite index
  // on production, the projection threw here, and the route answered a bare
  // 500 -- so the app said "check your connection" about a follow that had
  // in fact been saved. Each step below is best-effort and repeated by the
  // nightly job (`runFootballSyncJob`), so a failure reports the saved follow
  // with `fixturesDeferred: true` rather than denying it. Each step runs on
  // its own so one failing does not skip the others.
  let fixturesDeferred = false;
  const bestEffort = async (step: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      fixturesDeferred = true;
      console.error(`[football] ${step} after a saved follow failed`, error instanceof Error ? error.message : 'unknown error');
    }
  };

  // Remembered, not only used: the nightly projection has no request of its
  // own and reads the account's locale to keep titling matches in it.
  if (language) await bestEffort('saving the locale', () => setUserLocale(user.uid, language, now));
  // One follow, one watcher: the watcher screen lists exactly what this list
  // follows (closure CL7, `lib/football/footballWatchers.ts`).
  await bestEffort('reconciling watchers', () =>
    reconcileFootballWatchers(user.uid, followedClubIds, now, { language, createMissing: configured }));
  await bestEffort('projecting fixtures', () => projectFixturesForUser(user.uid, now, { language }));
  let fixtures: Awaited<ReturnType<typeof listActiveFixtureCommitments>> = [];
  await bestEffort('listing fixtures', async () => {
    fixtures = await listActiveFixtureCommitments(user.uid);
  });
  return Response.json({
    success: true, providerConfigured: configured, clubs: listClubs(), followedClubIds, fixtures,
    ...(fixturesDeferred ? { fixturesDeferred: true } : {}),
  });
}
