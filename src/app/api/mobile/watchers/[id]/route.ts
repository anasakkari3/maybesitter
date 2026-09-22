import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  applyWatcherPatch,
  parseWatcherId,
  parseWatcherPatch,
  presentWatcher,
  WatcherValidationError,
  watcherValidationResponse,
} from '../../../../../../lib/watchers/watcherApi';
import { createWatcherStore } from '../../../../../../lib/watchers/watcherStore';
import {
  assertPackWatcherMayBeEnabled,
  forgetPackWatcher,
  PackWatcherLockedError,
} from '../../../../../../lib/packs/packWatcherGuard';

export const dynamic = 'force-dynamic';

/**
 * Retunes a watcher (#525).
 *
 * `source` is refused rather than applied: a watcher repointed at another
 * subject would carry the old subject's baseline into the new one, and the
 * next observation would look like a change. Everything this route *does*
 * change re-primes the baseline, so no edit can itself cause a firing.
 *
 * A watcher id belonging to another account answers 404 — the same answer as
 * an id that never existed, and for the same reason it is the same answer:
 * this store only reads the caller's own tree, so it cannot tell the two apart
 * and must not be able to.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  const { id } = await context.params;
  try {
    const watcherId = parseWatcherId(id);
    const patch = parseWatcherPatch(body);
    const now = new Date().toISOString();
    const store = createWatcherStore(user.uid);
    if (patch.enabled === true) {
      // A pack's watchers are switched on by enabling the pack, never one at a
      // time from here: otherwise a lapsed subscriber could resume premium
      // behaviour by hand and the entitlement record would never know (#528).
      const current = await store.get(watcherId);
      if (!current) return mobileError('no such watcher', 404);
      await assertPackWatcherMayBeEnabled(user.uid, current);
    }
    const updated = await store.update(
      watcherId,
      (current) => applyWatcherPatch(current, patch, now),
    );
    if (!updated) return mobileError('no such watcher', 404);
    return Response.json({ success: true, watcher: presentWatcher(updated) });
  } catch (error) {
    if (error instanceof PackWatcherLockedError) return mobileError(error.message, 409);
    if (error instanceof WatcherValidationError) return watcherValidationResponse(error);
    console.error('[watchers] patching a watcher failed', error);
    return mobileError('could not update the watcher', 500);
  }
}

/**
 * Stops watching, for good.
 *
 * The firing history is deliberately left in place: it is the record of what
 * this account was already told, and deleting the configuration is not a claim
 * that those notifications never happened. It is removed with the account
 * (`watcherEvents` is a user-scoped collection, so `deleteTree(users/{uid})`
 * takes it), and #527 owns whatever user-facing history clearing it needs.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { id } = await context.params;
  try {
    const watcherId = parseWatcherId(id);
    const existed = await createWatcherStore(user.uid).remove(watcherId);
    if (!existed) return mobileError('no such watcher', 404);
    // A pack's record must not keep claiming a watcher that is gone (#528):
    // a dangling id is swallowed silently by every later enable and disable,
    // so the record would quietly claim more than it owns.
    await forgetPackWatcher(user.uid, watcherId, new Date().toISOString());
    return Response.json({ success: true, watcherId, deleted: true });
  } catch (error) {
    if (error instanceof WatcherValidationError) return watcherValidationResponse(error);
    console.error('[watchers] deleting a watcher failed', error);
    return mobileError('could not delete the watcher', 500);
  }
}
