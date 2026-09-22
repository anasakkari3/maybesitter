import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  HabitValidationError,
  habitValidationResponse,
  parseHabitId,
  parseHabitPatch,
  presentHabit,
} from '../../../../../../lib/habits/habitApi';
import { getHabitStore, habitsEnabled } from '../../../../../../lib/habits/habitStore';

export const dynamic = 'force-dynamic';

/**
 * Retunes a habit (#520).
 *
 * `source` is refused rather than applied — see `PATCH_KEYS` — because a habit
 * that came from a confirmed goal came from one for ever, and a client that
 * could restate it could relabel its own guesses as something the user agreed
 * to.
 *
 * Everything else is editable, including `status`: pausing a habit is a patch
 * rather than a route of its own, because there is nothing else pausing has to
 * do. The adapter reads `status` on every build (`buildHabitPlanningRequest`
 * drops a paused habit's occurrences), so a pause takes effect on the next
 * plan without any occurrence being rewritten.
 *
 * A habit id belonging to another account answers 404 — the same answer as an
 * id that never existed, and for the same reason it is the same answer: the
 * store only reads the caller's own tree, so it cannot tell the two apart and
 * must not be able to.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  if (!habitsEnabled()) return mobileError('habits are not enabled in this build', 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  const { id } = await context.params;
  try {
    const habitId = parseHabitId(id);
    const store = getHabitStore();
    // Read before validating: the occurrence bounds are a *pair*, and a patch
    // that moves only the minimum has to be checked against the maximum this
    // habit already holds. Validated in isolation, two individually legal
    // edits leave a habit that can never be materialized.
    const habits = await store.list(user.uid);
    const current = habits.find((habit) => habit.habitId === habitId);
    if (current === undefined) return mobileError('no such habit', 404);

    const patch = parseHabitPatch(body, current);
    const updated = await store.update(user.uid, habitId, patch, new Date().toISOString());
    if (updated === null) return mobileError('no such habit', 404);
    return Response.json({ success: true, habit: presentHabit(updated) });
  } catch (error) {
    if (error instanceof HabitValidationError) return habitValidationResponse(error);
    console.error('[habits] patching a habit failed', error);
    return mobileError('could not update the habit', 500);
  }
}

/**
 * Stops keeping this habit, for good.
 *
 * The habit's occurrences go with it, which is the opposite of the ruling the
 * watchers DELETE takes about its firing history, and for a reason rather than
 * an inconsistency: a watcher's history is a record of what this account was
 * *already told*, and deleting the configuration is not a claim those
 * notifications never happened. An open habit occurrence is not a record of
 * anything — it is dated work waiting to be planned — and one left behind with
 * no definition has no title, no duration and no flexibility, so the adapter
 * would drop it every morning for ever without anybody being told why.
 *
 * A user who means "stop for now" wants `status: 'paused'`, which is a PATCH
 * and keeps everything.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  if (!habitsEnabled()) return mobileError('habits are not enabled in this build', 503);

  const { id } = await context.params;
  try {
    const habitId = parseHabitId(id);
    const existed = await getHabitStore().remove(user.uid, habitId);
    if (!existed) return mobileError('no such habit', 404);
    return Response.json({ success: true, habitId, deleted: true });
  } catch (error) {
    if (error instanceof HabitValidationError) return habitValidationResponse(error);
    console.error('[habits] deleting a habit failed', error);
    return mobileError('could not delete the habit', 500);
  }
}
