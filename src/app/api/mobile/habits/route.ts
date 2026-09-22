import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../lib/services/mobile/response';
import {
  HabitValidationError,
  habitValidationResponse,
  parseNewHabit,
  presentHabit,
} from '../../../../../lib/habits/habitApi';
import { getHabitStore, habitsEnabled } from '../../../../../lib/habits/habitStore';

export const dynamic = 'force-dynamic';

/**
 * The habits this account keeps (#520).
 *
 * The account is the token's: every store method is given the verified uid, so
 * there is no query parameter and no body field that could name a different
 * tree. Another account's habits are not filtered out of this answer — they
 * were never in the collection it reads.
 *
 * `habitsEnabled` is checked after the guard and answers 503, because of what
 * backs this route today: see `lib/habits/habitStore.ts`. It is a build
 * saying "not yet", which is what 503 means, rather than a claim that this
 * account may not.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  if (!habitsEnabled()) return mobileError('habits are not enabled in this build', 503);

  try {
    const habits = await getHabitStore().list(user.uid);
    return Response.json({ success: true, items: habits.map(presentHabit) });
  } catch (error) {
    console.error('[habits] listing habits failed', error);
    return mobileError('could not read your habits', 500);
  }
}

/**
 * "I want to do this regularly."
 *
 * A habit is born `active` and `flexible` unless the body says otherwise. Both
 * defaults are in `parseNewHabit`: a habit the planner may move is the safe
 * one, and `protected_flexible` is a standing claim on an hour of somebody's
 * day that they should have to make deliberately.
 *
 * Creating a habit materializes nothing. The occurrences this habit will have
 * are the domain lane's to produce, and a POST that also wrote a week of dated
 * work would put two authors on the same question.
 */
export async function POST(request: Request) {
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

  try {
    const input = parseNewHabit(body);
    const created = await getHabitStore().create(user.uid, input, new Date().toISOString());
    return Response.json({ success: true, habit: presentHabit(created) }, { status: 201 });
  } catch (error) {
    if (error instanceof HabitValidationError) return habitValidationResponse(error);
    console.error('[habits] creating a habit failed', error);
    return mobileError('could not create the habit', 500);
  }
}
