import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { intelligenceDisabledResponse } from '../../../../../../../../lib/intelligence/gate';
import { answerIntelligenceQuestion } from '../../../../../../../../lib/intelligence/answerQuestion';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../../lib/net/requestBody';
import { suggestionAvailableForAction } from '../../../../../../../../lib/intelligence/memoryBasis';
import { getStorage } from '../../../../../../../../lib/storage';
import { dismissSuggestionWithDismissedOutcome, suggestionToDto } from '../../../../../../../../lib/intelligence/proposalEngine';

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
  const answer = (body as { answer?: unknown } | null)?.answer;
  if (typeof answer !== 'string' || answer.trim().length < 2 || answer.length > 500) {
    return Response.json({ success: false, reason: 'invalid_answer' }, { status: 400 });
  }
  const { id } = await context.params;
  const answeredAt = new Date().toISOString();
  if (!(await suggestionAvailableForAction(user.uid, id, answeredAt, getStorage()))) {
    await dismissSuggestionWithDismissedOutcome(user.uid, id, answeredAt, getStorage()).catch(() => false);
    return Response.json({ success: false, reason: 'suggestion_unavailable' }, { status: 404 });
  }
  try {
    const suggestion = await answerIntelligenceQuestion(user.uid, id, answer, new Date().toISOString());
    if (!suggestion) return Response.json({ success: false, reason: 'not_found' }, { status: 404 });
    return Response.json({ success: true, suggestion: suggestionToDto(suggestion) });
  } catch {
    return Response.json({ success: false, error: 'could not save answer' }, { status: 500 });
  }
}
