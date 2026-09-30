import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { intelligenceDisabledResponse } from '../../../../../../../lib/intelligence/gate';
import { reviewObservation } from '../../../../../../../lib/intelligence/observationStore';
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
  const review = (body as { review?: unknown } | null)?.review;
  if (review !== 'confirmed' && review !== 'dismissed') {
    return Response.json({ success: false, reason: 'invalid_review' }, { status: 400 });
  }
  const { id } = await context.params;
  try {
    const observation = await reviewObservation(user.uid, id, review, new Date().toISOString());
    if (!observation) return Response.json({ success: false, reason: 'not_found' }, { status: 404 });
    return Response.json({ success: true, observation });
  } catch {
    return Response.json({ success: false, error: 'could not apply review' }, { status: 500 });
  }
}
