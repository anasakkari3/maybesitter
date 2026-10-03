import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../../lib/consents/aiConsentService';
import { intelligenceDisabledResponse } from '../../../../../../lib/intelligence/gate';
import { learnFromCommitmentEvents } from '../../../../../../lib/intelligence/outcomeLearning';
import { VISIT_GENERATION_MIN_INTERVAL_MS, proposeFromObservations } from '../../../../../../lib/intelligence/proposalEngine';
import { previewSuggestionSchedule } from '../../../../../../lib/intelligence/schedulePreview';
import { readJsonBody } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  if (await getAiConsent(user.uid) !== 'granted') {
    return Response.json({ success: false, reason: 'consent_required' }, { status: 403 });
  }
  // `{ trigger: 'visit' }`: a screen opening (Today, «يتابع لك»), held to the
  // visit floor. Anything else — `{}` from the button, or a body an older
  // client never sent — is an explicit request, under the digest rule only.
  let visit = false;
  try { visit = (await readJsonBody<{ trigger?: unknown } | null>(request))?.trigger === 'visit'; }
  catch { visit = false; }
  try {
    await learnFromCommitmentEvents(user.uid);
    const suggestions = await proposeFromObservations(user.uid, new Date().toISOString(),
      visit ? { minIntervalMs: VISIT_GENERATION_MIN_INTERVAL_MS } : {});
    let schedule: Awaited<ReturnType<typeof previewSuggestionSchedule>> = [];
    try { schedule = await previewSuggestionSchedule(user.uid, suggestions, new Date().toISOString()); }
    catch { /* A failed preview never turns a suggestion into a false promise. */ }
    return Response.json({ success: true, suggestions, schedule });
  } catch {
    return Response.json({ success: false, error: 'could not prepare suggestions' }, { status: 500 });
  }
}
