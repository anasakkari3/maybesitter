import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { isPlanDate } from '../../../../../../../lib/services/dailyPlan/planSettings';
import { appendPlanEvent, readStoredPlan } from '../../../../../../../lib/services/dailyPlan/planStore';

export const dynamic = 'force-dynamic';

/**
 * "The plan was put on screen" (UC-3.16 follow-up, #533).
 *
 * The append is why this route exists: R3 (`lib/memoryGrowth/rules.ts`) may
 * only claim "you usually look at your plan around 08:30" from a record of
 * the plan being *opened*, and nothing wrote one. The record goes to the plan
 * ledger (`users/{uid}/planEvents`), deliberately not the domain log — a plan
 * is not an aggregate the reducer owns, the reason planStore's header gives —
 * and it carries the plan's own generation and digest read from the stored
 * document, never from the request: a type, a date, a number and a hash. No
 * titles, no times, nothing the plan says.
 *
 * A POST rather than a side effect of the plan GET: a read route cannot tell
 * "shown on screen" from a background refetch, and a GET that writes would
 * record both. The client sends this once per plan day the screen actually
 * shows, from the same mount effect that reports the analytics `plan_opened`
 * — a different store with the same name: analytics is consent-gated metrics,
 * this is the user's own append-only ledger, and R3's suggestion is the half
 * that stays behind personalization consent.
 *
 * 404 when there is no plan for that date, as the plan GET answers: a plan
 * that does not exist cannot be opened, and the response learns nothing a
 * caller could not learn from the GET.
 */
export async function POST(request: Request, { params }: { params: Promise<{ date: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { date } = await params;
  if (!isPlanDate(date)) return mobileError('date must be YYYY-MM-DD');

  const stored = await readStoredPlan(user.uid, date);
  if (!stored) return mobileError('no plan for that date', 404);

  await appendPlanEvent(user.uid, {
    type: 'plan_opened',
    date,
    at: new Date().toISOString(),
    generation: stored.generation,
    inputDigest: stored.inputDigest,
  });
  return Response.json({ success: true });
}
