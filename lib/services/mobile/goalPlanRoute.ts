import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../net/requestBody';
import { GoalPlanApiError } from './goalPlanService';
import { AccountUnavailableError, accountUnavailableResponse } from '../../account/accountLiveness';

export async function readGoalPlanBody(request: Request): Promise<Record<string, unknown>> {
  const body = await readJsonBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GoalPlanApiError(400, 'invalid_body');
  }
  return body as Record<string, unknown>;
}

export function goalPlanRouteError(error: unknown): Response {
  if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
  if (error instanceof GoalPlanApiError) {
    return Response.json(
      { success: false, error: error.reason, reason: error.reason, ...error.extra },
      { status: error.status },
    );
  }
  // The account was deleted while this request was on its way (#772): the
  // goal-plan writers re-read the account and refuse, and the answer is the
  // one a deleted account gets at sign-in.
  if (error instanceof AccountUnavailableError) return accountUnavailableResponse();
  if (error instanceof SyntaxError) {
    return Response.json({ success: false, error: 'invalid body', reason: 'invalid_body' }, { status: 400 });
  }
  return Response.json(
    { success: false, error: 'goal plan unavailable', reason: 'internal_error', retryable: true },
    { status: 500 },
  );
}
