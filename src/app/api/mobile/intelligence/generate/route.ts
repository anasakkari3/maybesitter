import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../../lib/consents/aiConsentService';
import { getRecommendationConsent } from '../../../../../../lib/consents/recommendationConsentService';
import { intelligenceDisabledResponse } from '../../../../../../lib/intelligence/gate';
import { learnOutcomesWithin } from '../../../../../../lib/intelligence/outcomeLearning';
import {
  hideDismissedOutcomeSuggestions, intelligenceRunPath, nextVisitAt, proposeFromObservations, reuseRunForVisit,
  suggestionToDto, type IntelligenceRun, type IntelligenceSuggestion,
} from '../../../../../../lib/intelligence/proposalEngine';
import { listObservations } from '../../../../../../lib/intelligence/observationStore';
import { previewSuggestionSchedule } from '../../../../../../lib/intelligence/schedulePreview';
import { readJsonBody } from '../../../../../../lib/net/requestBody';
import { getStorage } from '../../../../../../lib/storage';
import { m5bBasisMode } from '../../../../../../lib/release/m5bCapabilities';
import { readActiveMemorySnapshot, suggestionMatchesMode, suggestionProjection } from '../../../../../../lib/intelligence/memoryBasis';

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
    // Answered through the same dismissed-outcome filter as the inbox, read
    // after the run committed (M5B2A-R20-004): an outcome dismissed in between
    // never comes back as a suggestion on Today's banner.
    suggestions = hideDismissedOutcomeSuggestions(suggestions, await listObservations(user.uid));
    const mode = m5bBasisMode();
    const snapshot = mode === 'on_basis' ? await readActiveMemorySnapshot(user.uid, now, getStorage()) : undefined;
    suggestions = suggestions.filter(suggestion => suggestionMatchesMode(suggestion, mode, snapshot));
    let schedule: Awaited<ReturnType<typeof previewSuggestionSchedule>> = [];
    try { schedule = await previewSuggestionSchedule(user.uid, suggestions, new Date().toISOString()); }
    catch { /* A failed preview never turns a suggestion into a false promise. */ }
    // When a visit could next start a run, so the phone does not ask before.
    const run = visit ? await getStorage().get<IntelligenceRun>(intelligenceRunPath(user.uid)) : null;
    const dto = suggestions.map(suggestion => suggestionToDto(suggestion, suggestionProjection(suggestion, mode, snapshot)));
    return Response.json({ success: true, suggestions: dto, schedule, ...(visit ? { nextVisitAt: nextVisitAt(run, now) } : {}),
      ...(mode === 'off' ? {} : { basisMode: mode }) });
  } catch {
    return Response.json({ success: false, error: 'could not prepare suggestions' }, { status: 500 });
  }
}
