import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { AccountUnavailableError, accountUnavailableResponse } from '../../../../../../lib/account/accountLiveness';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';
import { commitmentToMobileDto, mobileError } from '../../../../../../lib/services/mobile/response';
import { dateFromOptionalIso } from '../../../../../../lib/services/mobile/time';
import { dismissUnhandled, listUnhandled, NotUnhandledError } from '../../../../../../lib/services/mobile/unhandledService';

export const dynamic = 'force-dynamic';

/** A commitment id, as every other route accepts one: short and a string. */
const MAX_ID_LENGTH = 128;

/**
 * «ما اتصرّفت فيها» (spec Part 1, design item 2, lane E2): appointments that
 * are over and deadlines that passed, still open. `referenceTime` is the
 * phone's "now", as for Today, so the two answer the same question.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  let now: Date;
  try {
    now = dateFromOptionalIso(new URL(request.url).searchParams.get('referenceTime'), new Date(), 'referenceTime');
  } catch {
    return mobileError('referenceTime must be an ISO instant');
  }
  const { items } = await listUnhandled(user.uid, { now });
  return Response.json({
    items: items.map((item) => ({
      reason: item.reason,
      since: item.since,
      shownAt: item.shownAt,
      askCount: item.askCount,
      commitment: commitmentToMobileDto(item.commitment),
    })),
  });
}

/**
 * «لا تسألني عنها»: `{ action: 'dismiss', commitmentId }`. The item leaves the
 * place and its status does not change. Done, a new date and dropped on
 * purpose are the commitment's own actions route, so they go through the same
 * commands and the same idempotency as everywhere else.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  let body: { action?: unknown; commitmentId?: unknown };
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return mobileError('Invalid JSON request body');
  if (body.action !== 'dismiss') return mobileError('action must be dismiss');
  const id = body.commitmentId;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
    return mobileError('commitmentId must be a commitment id');
  }

  try {
    const { replayed } = await dismissUnhandled(user.uid, id);
    return Response.json({ success: true, id, dismissed: true, ...(replayed ? { replayed: true } : {}) });
  } catch (error) {
    if (error instanceof AccountUnavailableError) return accountUnavailableResponse();
    if (error instanceof NotUnhandledError) return Response.json({ success: false, reason: 'not_unhandled' }, { status: 409 });
    if (error instanceof Error && error.message === 'Commitment not found') return mobileError('Commitment not found', 404);
    throw error;
  }
}
