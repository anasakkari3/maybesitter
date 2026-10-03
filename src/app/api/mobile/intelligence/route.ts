import { randomUUID } from 'node:crypto';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../lib/consents/aiConsentService';
import { analyzeSource } from '../../../../../lib/intelligence/analyzeSource';
import { intelligenceDisabledResponse } from '../../../../../lib/intelligence/gate';
import { listObservations } from '../../../../../lib/intelligence/observationStore';
import { learnOutcomesWhenEnabled } from '../../../../../lib/intelligence/outcomeLearning';
import { listSuggestions } from '../../../../../lib/intelligence/proposalEngine';
import { previewSuggestionSchedule } from '../../../../../lib/intelligence/schedulePreview';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  try {
    // Outcomes recorded since the last read become evidence before it is
    // shown (no model call); a failure here never hides the inbox.
    await learnOutcomesWhenEnabled(user.uid);
    const [observations, suggestions] = await Promise.all([
      listObservations(user.uid), listSuggestions(user.uid),
    ]);
    let schedule: Awaited<ReturnType<typeof previewSuggestionSchedule>> = [];
    try { schedule = await previewSuggestionSchedule(user.uid, suggestions, new Date().toISOString()); }
    catch { /* A failed preview must not hide the evidence or suggestions. */ }
    return Response.json({ success: true, observations, suggestions, schedule });
  } catch {
    return Response.json({ success: false, error: 'could not read intelligence inbox' }, { status: 500 });
  }
}

/** A guided user statement; source is assigned by the server, never by the caller. */
export async function POST(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  if (await getAiConsent(user.uid) !== 'granted') {
    return Response.json({ success: false, reason: 'consent_required' }, { status: 403 });
  }
  let body: unknown;
  try { body = await readJsonBody(request); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return Response.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  }
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 2_000) {
    return Response.json({ success: false, reason: 'invalid_text' }, { status: 400 });
  }
  try {
    const observations = await analyzeSource(user.uid, 'manual', randomUUID(), text, new Date().toISOString());
    return Response.json({ success: true, observations }, { status: 201 });
  } catch {
    return Response.json({ success: false, error: 'could not analyze statement' }, { status: 500 });
  }
}
