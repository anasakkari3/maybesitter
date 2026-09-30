import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../../lib/consents/aiConsentService';
import { intelligenceDisabledResponse } from '../../../../../../lib/intelligence/gate';
import { learnFromCommitmentEvents } from '../../../../../../lib/intelligence/outcomeLearning';
import { proposeFromObservations } from '../../../../../../lib/intelligence/proposalEngine';
import { previewSuggestionSchedule } from '../../../../../../lib/intelligence/schedulePreview';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  if (await getAiConsent(user.uid) !== 'granted') {
    return Response.json({ success: false, reason: 'consent_required' }, { status: 403 });
  }
  try {
    await learnFromCommitmentEvents(user.uid);
    const suggestions = await proposeFromObservations(user.uid, new Date().toISOString());
    let schedule: Awaited<ReturnType<typeof previewSuggestionSchedule>> = [];
    try { schedule = await previewSuggestionSchedule(user.uid, suggestions, new Date().toISOString()); }
    catch { /* A failed preview never turns a suggestion into a false promise. */ }
    return Response.json({ success: true, suggestions, schedule });
  } catch {
    return Response.json({ success: false, error: 'could not prepare suggestions' }, { status: 500 });
  }
}
