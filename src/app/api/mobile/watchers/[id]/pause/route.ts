import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import {
  applyWatcherPatch,
  parseWatcherId,
  presentWatcher,
  WatcherValidationError,
  watcherValidationResponse,
} from '../../../../../../../lib/watchers/watcherApi';
import { createWatcherStore } from '../../../../../../../lib/watchers/watcherStore';
import {
  assertPackWatcherMayBeEnabled,
  PackWatcherLockedError,
} from '../../../../../../../lib/packs/packWatcherGuard';

export const dynamic = 'force-dynamic';

/**
 * Pause, or resume (#525).
 *
 * The same route both ways — `{ "paused": false }` resumes — because "stop
 * watching this for now" and "start again" are one control on the surface
 * #527 will build, and two routes would let them drift apart.
 *
 * Pausing parks the watcher at `paused` in the same write that clears
 * `enabled`, so nothing has to wait for the next sweep to agree; the engine
 * re-checks `enabled` inside its own firing transaction anyway, so a pause
 * that lands mid-sweep still costs zero effects. Resuming clears the baseline,
 * so the watcher primes on its next observation and the changes that happened
 * while it was paused are absorbed rather than replayed.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  // An empty body means "pause" — the common case, and the one the button
  // sends. Anything present must be a boolean `paused` and nothing else.
  let paused = true;
  const raw = await request.text();
  if (raw.trim().length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return mobileError('Invalid JSON request body');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return mobileError('body must be an object');
    }
    const keys = Object.keys(body as Record<string, unknown>);
    if (keys.some((key) => key !== 'paused')) return mobileError('a pause does not accept that field');
    const value = (body as { paused?: unknown }).paused;
    if (value !== undefined && typeof value !== 'boolean') return mobileError('paused must be a boolean');
    paused = value ?? true;
  }

  const { id } = await context.params;
  try {
    const watcherId = parseWatcherId(id);
    const now = new Date().toISOString();
    const store = createWatcherStore(user.uid);
    if (!paused) {
      // Resuming a pack's watcher is the pack's decision, not this route's —
      // the same rule the PATCH route applies, and for the same reason (#528).
      const current = await store.get(watcherId);
      if (!current) return mobileError('no such watcher', 404);
      await assertPackWatcherMayBeEnabled(user.uid, current);
    }
    const updated = await store.update(
      watcherId,
      (current) => applyWatcherPatch(current, { enabled: !paused }, now),
    );
    if (!updated) return mobileError('no such watcher', 404);
    return Response.json({ success: true, watcher: presentWatcher(updated) });
  } catch (error) {
    if (error instanceof PackWatcherLockedError) return mobileError(error.message, 409);
    if (error instanceof WatcherValidationError) return watcherValidationResponse(error);
    console.error('[watchers] pausing a watcher failed', error);
    return mobileError('could not pause the watcher', 500);
  }
}
