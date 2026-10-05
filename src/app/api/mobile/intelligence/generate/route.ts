import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../../lib/consents/aiConsentService';
import { getRecommendationConsent } from '../../../../../../lib/consents/recommendationConsentService';
import { intelligenceDisabledResponse } from '../../../../../../lib/intelligence/gate';
import { learnOutcomesWithin } from '../../../../../../lib/intelligence/outcomeLearning';
import {
  intelligenceRunPath, nextVisitAt, proposeFromObservations, reuseRunForVisit,
  type IntelligenceRun, type IntelligenceSuggestion,
} from '../../../../../../lib/intelligence/proposalEngine';
import { previewSuggestionSchedule } from '../../../../../../lib/intelligence/schedulePreview';
import { readJsonBody } from '../../../../../../lib/net/requestBody';
import { getStorage } from '../../../../../../lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  if (await getAiConsent(user.uid) !== 'granted') {
    return Response.json({ success: false, reason: 'consent_required' }, { status: 403 });
  }
  if (await getRecommendationConsent(user.uid) !== 'granted') {
    return Response.json({ success: false, reason: 'consent_required' }, { status: 403 });
  }
  // `{ trigger: 'visit' }`: a screen opening (Today, «يتابع لك»), held to the
  // visit policy (`VISIT_POLICY`). Anything else — `{}` from the button, or a
  // body an older client never sent — is an explicit request, under the
  // digest rule only.
  let visit = false;
  try { visit = (await readJsonBody<{ trigger?: unknown } | null>(request))?.trigger === 'visit'; }
  catch { visit = false; }
  try {
    const now = new Date().toISOString();
    // A visit the policy refuses is answered from the latest run with one
    // read: no outcome scan, no sync, no context, no model.
    let suggestions: IntelligenceSuggestion[] | null = visit ? await reuseRunForVisit(user.uid, now) : null;
    if (!suggestions) {
      await learnOutcomesWithin(user.uid);
      suggestions = await proposeFromObservations(user.uid, now, { visit });
    }
    let schedule: Awaited<ReturnType<typeof previewSuggestionSchedule>> = [];
    try { schedule = await previewSuggestionSchedule(user.uid, suggestions, new Date().toISOString()); }
    catch { /* A failed preview never turns a suggestion into a false promise. */ }
    // When a visit could next start a run, so the phone does not ask before.
    const run = visit ? await getStorage().get<IntelligenceRun>(intelligenceRunPath(user.uid)) : null;
    return Response.json({ success: true, suggestions, schedule, ...(visit ? { nextVisitAt: nextVisitAt(run, now) } : {}) });
  } catch {
    return Response.json({ success: false, error: 'could not prepare suggestions' }, { status: 500 });
  }
}
