import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../lib/services/mobile/response';
import {
  parseNewWatcher,
  presentWatcher,
  WatcherValidationError,
  watcherValidationResponse,
} from '../../../../../lib/watchers/watcherApi';
import { createWatcherStore } from '../../../../../lib/watchers/watcherStore';
import {
  FootballNotConfiguredError,
  followClubWithWatcher,
  isFootballWatcherSource,
} from '../../../../../lib/football/footballWatchers';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * The watchers this account configured (#525).
 *
 * The account is the token's: `createWatcherStore(user.uid)` builds every path
 * from the verified uid, so there is no query parameter and no body field that
 * could name a different tree. Another account's watchers are not filtered out
 * of this answer — they were never in the collection it reads.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    const watchers = await createWatcherStore(user.uid).list();
    return Response.json({ success: true, items: watchers.map(presentWatcher) });
  } catch (error) {
    console.error('[watchers] listing watchers failed', error);
    return mobileError('could not read your watchers', 500);
  }
}

/**
 * "Watch this for me."
 *
 * A new watcher is born unprimed: it holds no baseline, and the engine only
 * fires on a transition away from one, so creating a watcher over a subject
 * that already changed yesterday does not fire for yesterday. The first sweep
 * absorbs the current state and the second is the first that can trigger.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  try {
    const input = parseNewWatcher(body);
    const now = new Date().toISOString();
    // Following a club is a watcher *and* a follow (closure CL7): the club's
    // matches go on the calendar and the watcher notices when one moves. It
    // answers 201 whether the follow is new or already existed, so a second
    // tap is the same follow rather than a second one.
    if (isFootballWatcherSource(input.source)) {
      const { watcher } = await followClubWithWatcher(user.uid, input, now);
      return Response.json({ success: true, watcher: presentWatcher(watcher) }, { status: 201 });
    }
    const created = await createWatcherStore(user.uid).create(input, now);
    return Response.json({ success: true, watcher: presentWatcher(created) }, { status: 201 });
  } catch (error) {
    if (error instanceof FootballNotConfiguredError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 409 });
    }
    if (error instanceof WatcherValidationError) return watcherValidationResponse(error);
    console.error('[watchers] creating a watcher failed', error);
    return mobileError('could not create the watcher', 500);
  }
}
