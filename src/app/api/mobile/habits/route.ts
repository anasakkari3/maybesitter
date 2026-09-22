import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../lib/services/mobile/response';
import { parseHabitDefinitionInput } from '../../../../../src/contracts/v1/habitContracts';
import {
  HabitValidationError,
  checkNewHabitBody,
  habitValidationResponse,
  presentHabit,
  presentOccurrence,
  withVerifiedScope,
} from '../../../../../lib/services/habits/habitApi';
import {
  createHabitServices,
  createHabitWithOccurrences,
  todayLocalDateFor,
} from '../../../../../lib/services/habits/habitService';

export const dynamic = 'force-dynamic';

/**
 * The habits this account keeps (#520).
 *
 * The account is the token's: `list(user.uid)` builds every path from the
 * verified uid, so there is no query parameter and no body field that could
 * name a different tree. Another account's habits are not filtered out of this
 * answer — they were never in the collection it reads.
 *
 * Paused and archived habits are included. A list that hid them would leave the
 * user no way to un-pause one, and `status` is on every row.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    const habits = await createHabitServices().habits.list(user.uid);
    return Response.json({ success: true, items: habits.map(presentHabit) });
  } catch (error) {
    console.error('[habits] listing habits failed', error);
    return mobileError('could not read your habits', 500);
  }
}

/**
 * "I want to do this regularly", and the dates that implies.
 *
 * ── The body cannot choose the tree ──────────────────────────────
 *
 * `scopeId` is spread *after* the body, so a client that sent one has it
 * overwritten by the verified uid rather than honoured. This is the one line
 * standing between a token and another account's habits, and it is ordered
 * deliberately.
 *
 * ── Nothing here defaults the confirmation ───────────────────────
 *
 * `parseHabitDefinitionInput` refuses a body with no `confirmation`, and this
 * route does not fill one in. That is #520's core invariant — goal or memory
 * text never becomes a habit on its own — and a server that stamped its own
 * clock onto a missing receipt would turn the evidence into a formality. Same
 * for `flexibility`, `recoveryPolicy` and `source`: the domain requires them
 * explicitly, and a route-level default would be this lane quietly re-deciding
 * something the contract made the caller state.
 *
 * ── Creating a habit materializes its horizon ────────────────────
 *
 * Four weeks of dates, written at deterministic ids, so the response tells the
 * client what it actually asked the week for rather than only that a rule was
 * stored. Re-running it writes the same rows again; see `habitOccurrenceStore`.
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
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  try {
    // The uid last. See the header.
    const input = parseHabitDefinitionInput(withVerifiedScope(checkNewHabitBody(body), user.uid));
    const now = new Date();
    const { habit, materialization } = await createHabitWithOccurrences(
      createHabitServices(),
      input,
      now.toISOString(),
      todayLocalDateFor(now, new URL(request.url).searchParams.get('timezone') ?? undefined),
    );
    return Response.json({
      success: true,
      habit: presentHabit(habit),
      occurrences: materialization.occurrences.map(presentOccurrence),
    }, { status: 201 });
  } catch (error) {
    if (error instanceof HabitValidationError) return habitValidationResponse(error);
    console.error('[habits] creating a habit failed', error);
    return mobileError('could not create the habit', 500);
  }
}
