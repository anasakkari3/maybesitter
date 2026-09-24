import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { isPlanDate } from '../../../../../../../lib/services/dailyPlan/planSettings';
import { planCause } from '../../../../../../../lib/services/dailyPlan/planCause';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/plans/{date}/cause` (#527, AC 2).
 *
 * Which monitor/watcher caused this daily plan replan:
 * `monitor/watcher → condition → policy → resulting action`.
 *
 * Returns 404 if no plan exists for the date.
 * If the plan was built manually or predates cause tracking, answers with
 * empty `causeChangeIds` and `attributions`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ date: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { date } = await params;
  if (!isPlanDate(date)) return mobileError('date must be YYYY-MM-DD');

  try {
    const cause = await planCause(user.uid, date);
    if (!cause) return mobileError('no plan for that date', 404);

    return Response.json({
      success: true,
      cause,
    });
  } catch (error) {
    console.error('[dailyPlan] reading plan cause failed', error);
    return mobileError('could not read plan cause', 500);
  }
}
