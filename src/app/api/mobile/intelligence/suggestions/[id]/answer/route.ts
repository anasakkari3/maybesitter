import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { getRecommendationConsent } from '../../../../../../../../lib/consents/recommendationConsentService';
import { intelligenceDisabledResponse } from '../../../../../../../../lib/intelligence/gate';
import { answerIntelligenceQuestion } from '../../../../../../../../lib/intelligence/answerQuestion';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../../lib/net/requestBody';
import { SuggestionUnavailableError } from '../../../../../../../../lib/intelligence/memoryBasis';
import { suggestionToDto } from '../../../../../../../../lib/intelligence/proposalEngine';
import { clientSupportsReadd } from '../../../../../../../../lib/intelligence/readd';

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
  // An answer is analysed by the model and becomes an observation, so it is
  // held to the consent generating and accepting are (CXA7.3): revoked on
  // another device, a stale screen's answer runs nothing.
  if (await getRecommendationConsent(user.uid) !== 'granted') {
    return Response.json({ success: false, reason: 'consent_required' }, { status: 403 });
  }
  const { id } = await context.params;
  const answeredAt = new Date().toISOString();
  try {
    const suggestion = await answerIntelligenceQuestion(user.uid, id, answer, answeredAt, undefined,
      clientSupportsReadd(request));
    if (!suggestion) return Response.json({ success: false, reason: 'suggestion_unavailable' }, { status: 404 });
    return Response.json({ success: true, suggestion: suggestionToDto(suggestion) });
  } catch (error) {
    if (error instanceof SuggestionUnavailableError) {
      return Response.json({ success: false, reason: error.result.reason }, { status: 404 });
    }
    return Response.json({ success: false, error: 'could not save answer' }, { status: 500 });
  }
}
