/**
 * What the ICS feed routes do (UC-3.4, #188), kept out of the route files so
 * each route is one line and every refusal is decided in one place.
 *
 * Authentication happens in each route file, lexically, where
 * `tests/auth/routeGuardCoverage.test.ts` can see it; the handlers here take
 * the authenticated uid. After that, for every handler: the feature flag, then
 * (for anything that fetches) the calendar consent, then the body. The flag
 * answers 404 so a disabled deployment looks like one without the feature.
 *
 * Every error body is `{ success: false, error: <code>, reason: <code>,
 * detail?: <code> }` — codes only. A thrown error that is not an
 * `IcsFeedError` answers a bare 500 and is logged by name only: an error from
 * deep in a fetch could carry the URL.
 */
import { authorizeSchedulerRequest, schedulerAuthErrorResponse, type HeaderBearing, type OidcVerify } from '../auth/schedulerOidc';
import { readTrust } from '../pilot/pilotTrustStore';
import {
  createIcsFeed,
  decideIcsDeadline,
  deleteIcsFeed,
  icsFeedsEnabled,
  IcsFeedError,
  listIcsDeadlines,
  listIcsFeeds,
  refreshIcsFeed,
  runIcsRefreshTick,
  updateIcsFeed,
  type IcsFeedDeps,
  type IcsRefreshTickTotals,
} from './icsFeeds';

export interface IcsRouteDeps extends IcsFeedDeps {
  env?: NodeJS.ProcessEnv;
}

function refusal(error: IcsFeedError): Response {
  return Response.json(
    { success: false, error: error.code, reason: error.code, ...(error.detail ? { detail: error.detail } : {}) },
    { status: error.status },
  );
}

async function guarded(
  uid: string,
  deps: IcsRouteDeps,
  options: { consent: boolean },
  run: (uid: string) => Promise<Response>,
): Promise<Response> {
  if (!icsFeedsEnabled(deps.env)) return refusal(new IcsFeedError('feature_disabled'));
  if (options.consent) {
    const trust = await readTrust(uid);
    if (trust?.calendarConsent !== true) {
      return Response.json(
        { success: false, error: 'calendar_consent_required', reason: 'calendar_consent_required' },
        { status: 403 },
      );
    }
  }
  try {
    return await run(uid);
  } catch (error) {
    if (error instanceof IcsFeedError) return refusal(error);
    console.error('[mobile/calendar/ics] unexpected failure', error instanceof Error ? error.name : 'unknown');
    return Response.json({ success: false, error: 'internal_error', reason: 'internal_error' }, { status: 500 });
  }
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new IcsFeedError('invalid_request');
  }
}

/** `GET /api/mobile/calendar/ics`: the feeds, and the deadlines waiting on the user. */
export function handleListFeeds(request: Request, uid: string, deps: IcsRouteDeps = {}): Promise<Response> {
  return guarded(uid, deps, { consent: false }, async (uid) => Response.json({
    success: true,
    feeds: await listIcsFeeds(uid, deps),
    deadlines: await listIcsDeadlines(uid, deps),
  }));
}

/** `POST /api/mobile/calendar/ics`: subscribe, fetching once, and answer a preview. */
export function handleCreateFeed(request: Request, uid: string, deps: IcsRouteDeps = {}): Promise<Response> {
  return guarded(uid, deps, { consent: true }, async (uid) => {
    const result = await createIcsFeed(uid, await jsonBody(request), deps);
    return Response.json({ success: true, ...result }, { status: 201 });
  });
}

export function handleUpdateFeed(request: Request, uid: string, feedId: string, deps: IcsRouteDeps = {}): Promise<Response> {
  return guarded(uid, deps, { consent: false }, async (uid) => Response.json({
    success: true,
    feed: await updateIcsFeed(uid, feedId, await jsonBody(request), deps),
  }));
}

/** Unsubscribing needs no consent: the person removing it may just have turned consent off. */
export function handleDeleteFeed(request: Request, uid: string, feedId: string, deps: IcsRouteDeps = {}): Promise<Response> {
  return guarded(uid, deps, { consent: false }, async (uid) => Response.json({
    success: true,
    ...(await deleteIcsFeed(uid, feedId, deps)),
  }));
}

export function handleRefreshFeed(request: Request, uid: string, feedId: string, deps: IcsRouteDeps = {}): Promise<Response> {
  return guarded(uid, deps, { consent: true }, async (uid) => {
    const result = await refreshIcsFeed(uid, feedId, { manual: true }, deps);
    return Response.json({ success: result.outcome !== 'failed', ...result });
  });
}

export function handleDeadlineDecision(
  request: Request,
  uid: string,
  feedId: string,
  itemKey: string,
  deps: IcsRouteDeps = {},
): Promise<Response> {
  return guarded(uid, deps, { consent: false }, async (uid) => Response.json({
    success: true,
    ...(await decideIcsDeadline(uid, feedId, itemKey, await jsonBody(request), deps)),
  }));
}

export interface IcsRefreshRouteDeps extends IcsFeedDeps {
  env?: NodeJS.ProcessEnv;
  verify?: OidcVerify;
  tick?: () => Promise<IcsRefreshTickTotals>;
}

/**
 * `POST /api/internal/calendar/ics/refresh`, called by Cloud Scheduler.
 *
 * The same `authorizeSchedulerRequest` as every other internal job — audience
 * and service account verified, every refusal the same 401. Authentication
 * comes before the flag, so an unauthenticated caller cannot even learn
 * whether the feature is on.
 */
export async function handleIcsRefreshTick(request: HeaderBearing, deps: IcsRefreshRouteDeps = {}): Promise<Response> {
  const auth = await authorizeSchedulerRequest(request, {
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.verify ? { verify: deps.verify } : {}),
  });
  if (!auth.ok) return schedulerAuthErrorResponse(auth);
  if (!icsFeedsEnabled(deps.env)) return Response.json({ skipped: 'feature_disabled' });
  try {
    return Response.json(await (deps.tick ?? (() => runIcsRefreshTick(deps)))());
  } catch (error) {
    console.error('[internal/calendar/ics/refresh] sweep failed', error instanceof Error ? error.name : 'unknown');
    return Response.json({ error: 'ics_refresh_failed' }, { status: 500 });
  }
}
