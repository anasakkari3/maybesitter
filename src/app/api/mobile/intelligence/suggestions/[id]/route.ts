import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { intelligenceDisabledResponse } from '../../../../../../../lib/intelligence/gate';
import { InvalidSuggestionEditError, QuestionAnswerRequiredError, reviewSuggestion } from '../../../../../../../lib/intelligence/reviewSuggestion';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  let body: unknown;
  try { body = await readJsonBody(request); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return Response.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  }
  const decision = (body as { decision?: unknown } | null)?.decision;
  const title = (body as { title?: unknown } | null)?.title;
  if (decision !== 'accept' && decision !== 'dismiss') {
    return Response.json({ success: false, reason: 'invalid_decision' }, { status: 400 });
  }
  if (title !== undefined && (typeof title !== 'string' || title.trim().length < 4 || title.trim().length > 100)) {
    return Response.json({ success: false, reason: 'invalid_title' }, { status: 400 });
  }
  const { id } = await context.params;
  try {
    const suggestion = await reviewSuggestion(user.uid, id, decision, new Date().toISOString(), undefined,
      title === undefined ? {} : { title });
    if (!suggestion) return Response.json({ success: false, reason: 'not_found' }, { status: 404 });
    return Response.json({ success: true, suggestion });
  } catch (error) {
    if (error instanceof QuestionAnswerRequiredError) {
      return Response.json({ success: false, reason: 'question_requires_answer' }, { status: 400 });
    }
    if (error instanceof InvalidSuggestionEditError) {
      return Response.json({ success: false, reason: 'invalid_title' }, { status: 400 });
    }
    return Response.json({ success: false, error: 'could not apply decision' }, { status: 500 });
  }
}
