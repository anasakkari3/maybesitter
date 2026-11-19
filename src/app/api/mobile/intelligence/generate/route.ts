import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../../lib/consents/aiConsentService';
import { getRecommendationConsent } from '../../../../../../lib/consents/recommendationConsentService';
import { intelligenceDisabledResponse } from '../../../../../../lib/intelligence/gate';
import { learnOutcomesWithin } from '../../../../../../lib/intelligence/outcomeLearning';
import {
  hideDismissedOutcomeSuggestions, hideSavedGoalProposals, intelligenceRunPath, nextVisitAt, proposeFromObservations, reuseRunForVisit,
  suggestionToDto, type IntelligenceRun, type IntelligenceSuggestion,
} from '../../../../../../lib/intelligence/proposalEngine';
import { listObservations } from '../../../../../../lib/intelligence/observationStore';
import { previewSuggestionSchedule } from '../../../../../../lib/intelligence/schedulePreview';
import { RequestBodyTooLargeError, readBoundedText, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';
import { getStorage } from '../../../../../../lib/storage';
import { m5bBasisMode } from '../../../../../../lib/release/m5bCapabilities';
import { readActiveMemorySnapshot, suggestionMatchesMode, suggestionProjection } from '../../../../../../lib/intelligence/memoryBasis';
import { clientSupportsReadd, resolveReaddPolicy } from '../../../../../../lib/intelligence/readd';

export const dynamic = 'force-dynamic';

/** The phone sends `{}` or `{ "trigger": "visit" }`; nothing legitimate is near this. */
const GENERATE_BODY_LIMIT_BYTES = 4 * 1024;

type GenerateTrigger = 'visit' | 'explicit';

/**
 * Which request this is, or null for a body that is neither (CXA7.2).
 *
 * `{ trigger: 'visit' }`: a screen opening (Today, «يتابع لك»), held to the
 * visit policy (`VISIT_POLICY`). `{}` from the button, or no body at all from
 * an older client, is an explicit request, under the digest rule only.
 * Anything else — not JSON, not an object, a `trigger` that is not `visit` —
 * used to fall through to "explicit" and so skipped the visit floor.
 */
function generateTriggerOf(text: string): GenerateTrigger | null {
  if (text.trim() === '') return 'explicit';
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { trigger } = body as { trigger?: unknown };
  if (trigger === undefined) return 'explicit';
  return trigger === 'visit' ? 'visit' : null;
}

export async function POST(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  // The body is read and judged before anything else is (CXA7.2): a body that
  // is not one of the two the phone sends is refused, never read as an
  // explicit request — which would skip the visit floor and reach the model.
  let trigger: GenerateTrigger | null;
  try { trigger = generateTriggerOf(await readBoundedText(request, { limitBytes: GENERATE_BODY_LIMIT_BYTES })); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return Response.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  }
  if (!trigger) return Response.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  if (await getAiConsent(user.uid) !== 'granted') {
    return Response.json({ success: false, reason: 'consent_required' }, { status: 403 });
  }
  if (await getRecommendationConsent(user.uid) !== 'granted') {
    return Response.json({ success: false, reason: 'consent_required' }, { status: 403 });
  }
  const visit = trigger === 'visit';
  try {
    const now = new Date().toISOString();
    const readdSupported = clientSupportsReadd(request);
    // A visit the policy refuses is answered from the latest run with one
    // read: no outcome scan, no sync, no context, no model.
    let suggestions: IntelligenceSuggestion[] | null = visit ? await reuseRunForVisit(user.uid, now) : null;
    if (!suggestions) {
      await learnOutcomesWithin(user.uid);
      suggestions = await proposeFromObservations(user.uid, now, { visit, readdClientSupported: readdSupported });
    }
    // Answered through the same dismissed-outcome filter as the inbox, read
    // after the run committed (M5B2A-R20-004): an outcome dismissed in between
    // never comes back as a suggestion on Today's banner.
    const observations = await listObservations(user.uid);
    // …and the saved-goal filter too (QA CA7.10): a goal confirmed into memory
    // after the run never shows on the banner while «يتابع لك» hides it.
    suggestions = hideDismissedOutcomeSuggestions(hideSavedGoalProposals(suggestions, observations), observations);
    const readdPolicy = await resolveReaddPolicy(user.uid, observations, readdSupported);
    suggestions = suggestions.filter(readdPolicy.allowsSuggestion);
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
