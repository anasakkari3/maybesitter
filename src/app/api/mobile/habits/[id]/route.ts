import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { parseHabitPatchInput } from '../../../../../../src/contracts/v1/habitContracts';
import {
  HabitValidationError,
  checkHabitPatchBody,
  habitValidationResponse,
  parseHabitId,
  presentHabit,
  presentOccurrence,
} from '../../../../../../lib/services/habits/habitApi';
import {
  createHabitServices,
  patchHabitWithOccurrences,
  removeHabitWithOccurrences,
  todayLocalDateFor,
} from '../../../../../../lib/services/habits/habitService';

export const dynamic = 'force-dynamic';

/**
 * Retunes a habit, and brings its dates in line with the new rule (#520).
 *
 * ── The patch cannot rewrite the receipt ─────────────────────────
 *
 * `source` and `confirmation` are not patchable keys. Editing a habit is not
 * re-confirming it, and a patch that could restate where the habit came from
 * would let a client relabel its own guesses as something the user agreed to —
 * which is the provenance #520's confirmation invariant exists to protect.
 * `parseHabitPatchInput` enforces the same thing one layer down.
 *
 * ── Every patch re-materializes, including a pause ───────────────
 *
 * A cadence edited from five days a week to three withdraws the untouched
 * `pending` rows the rule no longer asks for and keeps every date the person
 * actually touched — and `status: 'paused'` is the same operation with no
 * demand dates at all. That is "pausing removes future demand without deleting
 * history", and it is the domain lane's merge rule rather than a second one
 * written here: see `resyncHabitOccurrences`.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  const { id } = await context.params;
  try {
    const habitId = parseHabitId(id);
    const patch = parseHabitPatchInput(checkHabitPatchBody(body));
    const now = new Date();
    const updated = await patchHabitWithOccurrences(
      createHabitServices(),
      user.uid,
      habitId,
      patch,
      now.toISOString(),
      todayLocalDateFor(now, new URL(request.url).searchParams.get('timezone') ?? undefined),
    );
    if (updated === null) return mobileError('no such habit', 404);
    return Response.json({
      success: true,
      habit: presentHabit(updated.habit),
      occurrences: updated.materialization.occurrences.map(presentOccurrence),
    });
  } catch (error) {
    if (error instanceof HabitValidationError) return habitValidationResponse(error);
    console.error('[habits] patching a habit failed', error);
    return mobileError('could not update the habit', 500);
  }
}

/**
 * Stops keeping this habit, for good, and takes its dates with it.
 *
 * Both, because an occurrence that outlives its rule has a title nowhere, a
 * duration policy nowhere and no flexibility — the adapter would drop it every
 * morning for ever without anybody being told why. That is the opposite of the
 * ruling the watchers DELETE takes about its firing history, and for a reason
 * rather than an inconsistency: a watcher's history is a record of what this
 * account was *already told*, while an open habit occurrence is dated work
 * still waiting to be planned.
 *
 * A user who means "stop for now" wants `PATCH` with `status: 'paused'`, which
 * keeps every date they have already answered about.
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
    const habitId = parseHabitId(id);
    const existed = await removeHabitWithOccurrences(createHabitServices(), user.uid, habitId);
    if (!existed) return mobileError('no such habit', 404);
    return Response.json({ success: true, habitId, deleted: true });
  } catch (error) {
    if (error instanceof HabitValidationError) return habitValidationResponse(error);
    console.error('[habits] deleting a habit failed', error);
    return mobileError('could not delete the habit', 500);
  }
}
