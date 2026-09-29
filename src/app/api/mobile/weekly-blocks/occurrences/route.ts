import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { WEEKLY_BLOCK_OCCURRENCE_RANGE_MAX_DAYS } from '../../../../../../src/contracts/v1/weeklyBlockContracts';
import { listWeeklyBlockOccurrences } from '../../../../../../lib/weeklyBlocks/weeklyBlockService';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

function instantParam(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * The weekly blocks' occurrences in `[from, to)` — ISO instants, at most 62
 * days apart; the next seven days by default — each with its block's title, so
 * the Calendar tab and Today can draw «تدريب 10:00–16:00». These are exactly
 * the busy blocks the planner reads, so what the phone shows is what the plan
 * keeps free.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const url = new URL(request.url);
  const nowMs = Date.now();
  const from = instantParam(url.searchParams.get('from')) ?? nowMs;
  const to = instantParam(url.searchParams.get('to')) ?? from + 7 * DAY_MS;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return mobileError('from and to must be ISO-8601 instants');
  if (to <= from) return mobileError('to must be after from');
  if (to - from > WEEKLY_BLOCK_OCCURRENCE_RANGE_MAX_DAYS * DAY_MS) {
    return mobileError(`from and to may be at most ${WEEKLY_BLOCK_OCCURRENCE_RANGE_MAX_DAYS} days apart`);
  }

  const window = { startsAt: new Date(from).toISOString(), endsAt: new Date(to).toISOString() };
  try {
    const items = await listWeeklyBlockOccurrences(user.uid, window);
    return Response.json({ success: true, from: window.startsAt, to: window.endsAt, items });
  } catch (error) {
    console.error('[weekly-blocks] occurrences read failed', error instanceof Error ? error.name : 'unknown');
    return mobileError('could not read your weekly blocks', 500);
  }
}
