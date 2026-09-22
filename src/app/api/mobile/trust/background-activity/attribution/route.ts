import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import {
  ATTRIBUTION_MAX_LIMIT,
  attributionsForArtifacts,
  listBackgroundAttribution,
} from '../../../../../../../lib/watchers/backgroundAttribution';

export const dynamic = 'force-dynamic';

/** Refs are ids this system minted; a long list is a scan, so it is bounded. */
const MAX_REFS = 50;

/**
 * `GET /api/mobile/trust/background-activity/attribution` (#527).
 *
 * Who decided a background action, on what evidence, and under whose
 * permission: `monitor/watcher → condition → policy → resulting action`, which
 * is the issue's Rule stated as a route. A read projection over the firings
 * Watchers (#525) already records — no store of its own, and nothing here
 * starts, stops or schedules any work.
 *
 * The account is the token's. Every read builds its path from the verified
 * uid, exactly as the sibling `background-activity` route does, so there is no
 * parameter that could name another account's tree: another account's actions
 * are not filtered out of this answer, they were never in the collections it
 * reads.
 *
 * ── Two questions, one route ──────────────────────────────────────
 *
 * With no `ref`, it answers "what has been done for me lately", newest first
 * and bounded.
 *
 * With one or more `ref`, it answers "what caused *this*" — the question a
 * replan asks. #524's `IncrementalPlanPatch` carries the ids of the state
 * changes it was built from in `causeChangeIds`, and those ids are exactly the
 * `effectRef`s of the firings that produced them, so passing them here turns a
 * replan back into the monitors behind it. A ref that matches nothing is
 * simply absent from the answer; see `attributionsForArtifacts`.
 *
 * `orphanCount` rides on the unfiltered answer: it is the Rule's second half —
 * "no orphan autonomous work" — as a number, and zero is the only healthy
 * value. It is reported rather than raised, because a Trust surface that
 * refused to render when something was wrong would hide the thing it exists to
 * show.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  const refs = searchParams.getAll('ref').filter((ref) => ref.length > 0);
  if (refs.length > MAX_REFS) {
    return mobileError(`at most ${MAX_REFS} refs may be asked about at once`);
  }

  const rawLimit = searchParams.get('limit');
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > ATTRIBUTION_MAX_LIMIT) {
      return mobileError(`limit must be an integer between 1 and ${ATTRIBUTION_MAX_LIMIT}`);
    }
    limit = parsed;
  }

  try {
    if (refs.length > 0) {
      const actions = await attributionsForArtifacts(user.uid, refs);
      return Response.json({ success: true, actions });
    }
    const view = await listBackgroundAttribution(user.uid, { limit });
    return Response.json({ success: true, ...view });
  } catch (error) {
    console.error('[trust] listing background attribution failed', error);
    return mobileError('could not read what caused your background activity', 500);
  }
}
