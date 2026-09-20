import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import {
  parseHistoryLimit,
  parseWatcherId,
  presentWatcherEvent,
  WatcherValidationError,
  watcherValidationResponse,
} from '../../../../../../../lib/watchers/watcherApi';
import { createWatcherStore } from '../../../../../../../lib/watchers/watcherStore';

export const dynamic = 'force-dynamic';

/**
 * What this watcher has actually done (#525), newest first.
 *
 * Every row carries the reason it fired, the policy decision that let it, and
 * the provenance pointer for the observation behind it — the issue's "every
 * execution carries provenance and a reason", read back rather than only
 * written. Refusals are rows too: a firing the Action Policy blocked appears
 * as `outcome: "policy_blocked"`, because a history that showed only successes
 * would be evidence of the wrong thing.
 *
 * The watcher is read first so that a history request for an id this account
 * does not own is a 404 before any event query runs — and the query itself is
 * over `users/{uid}/watcherEvents`, so it could not have returned another
 * account's rows either way.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { id } = await context.params;
  try {
    const watcherId = parseWatcherId(id);
    const limit = parseHistoryLimit(new URL(request.url).searchParams.get('limit'));
    const store = createWatcherStore(user.uid);
    if (!(await store.get(watcherId))) return mobileError('no such watcher', 404);
    const events = await store.listEvents(watcherId, limit);
    return Response.json({ success: true, watcherId, items: events.map(presentWatcherEvent) });
  } catch (error) {
    if (error instanceof WatcherValidationError) return watcherValidationResponse(error);
    console.error('[watchers] reading a watcher history failed', error);
    return mobileError('could not read this watcher history', 500);
  }
}
