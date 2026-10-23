import { randomUUID } from 'node:crypto';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../lib/consents/aiConsentService';
import { getRecommendationConsent } from '../../../../../lib/consents/recommendationConsentService';
import { analyzeSource } from '../../../../../lib/intelligence/analyzeSource';
import { intelligenceDisabledResponse } from '../../../../../lib/intelligence/gate';
import { listObservations } from '../../../../../lib/intelligence/observationStore';
import { learnOutcomesWithin } from '../../../../../lib/intelligence/outcomeLearning';
import { hideDismissedOutcomeSuggestions, hideSavedGoalProposals, listSuggestions, suggestionToDto } from '../../../../../lib/intelligence/proposalEngine';
import { previewSuggestionSchedule } from '../../../../../lib/intelligence/schedulePreview';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../lib/net/requestBody';
import { isPlanImperative } from '../../../../../lib/services/mobile/goalPlanService';
import { resolveModuleRuntime } from '../../../../../src/contracts/v1/runtimeControls';
import { resolveMemoryLearning } from '../../../../../lib/release/m5bCapabilities';
import { m5bBasisMode } from '../../../../../lib/release/m5bCapabilities';
import { cleanupMemoryResidues, filterMemoryObservations, readActiveMemorySnapshot, suggestionMatchesMode, suggestionProjection } from '../../../../../lib/intelligence/memoryBasis';
import { getStorage } from '../../../../../lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  try {
    // Outcomes recorded since the last read become evidence before it is
    // shown (no model call); a failure here never hides the inbox.
    await learnOutcomesWithin(user.uid);
    const [observations, consent] = await Promise.all([
      listObservations(user.uid), getRecommendationConsent(user.uid),
    ]);
    // Keep the person's evidence review available after a revocation, but
    // never display an old recommendation under an off switch.
    const storedSuggestions = consent === 'granted'
      ? hideDismissedOutcomeSuggestions(hideSavedGoalProposals(await listSuggestions(user.uid), observations), observations) : [];
    const mode = m5bBasisMode();
    const now = new Date().toISOString();
    const snapshot = mode === 'on_basis' ? await readActiveMemorySnapshot(user.uid, now, getStorage()) : undefined;
    const visibleStored = storedSuggestions.filter(suggestion => suggestionMatchesMode(suggestion, mode, snapshot));
    const suggestions = visibleStored.map(suggestion => suggestionToDto(suggestion, suggestionProjection(suggestion, mode, snapshot)));
    let schedule: Awaited<ReturnType<typeof previewSuggestionSchedule>> = [];
    try { schedule = await previewSuggestionSchedule(user.uid, visibleStored, now); }
    catch { /* A failed preview must not hide the evidence or suggestions. */ }
    const visibleObservations = filterMemoryObservations(observations, mode, snapshot);
    const projectedObservations = resolveMemoryLearning() ? visibleObservations.map(observation => {
      if (observation.source !== 'behavior' || observation.kind !== 'outcome') return observation;
      // A title may span lines (M5B2A-REV-007).
      const match = /^(Completed|Postponed|Dropped): ([\s\S]+)$/.exec(observation.evidence);
      if (!match) return observation;
      const signal = match[1] === 'Completed' ? 'completed' : match[1] === 'Postponed' ? 'postponed' : 'dropped';
      return { ...observation, outcome: { signal, title: match[2] } };
    }) : visibleObservations;
    if (mode === 'on_basis' && snapshot?.available) void cleanupMemoryResidues(user.uid, now, getStorage(), snapshot).catch(() => undefined);
    return Response.json({ success: true, observations: projectedObservations, suggestions, schedule,
      ...(mode === 'off' ? {} : { basisMode: mode }) });
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
  if (resolveModuleRuntime('goalPlan').mode === 'enabled' && isPlanImperative(text)) {
    return Response.json({ success: true, route: 'plan_flow' });
  }
  try {
    const observations = await analyzeSource(user.uid, 'manual', randomUUID(), text, new Date().toISOString());
    return Response.json({ success: true, observations }, { status: 201 });
  } catch {
    return Response.json({ success: false, error: 'could not analyze statement' }, { status: 500 });
  }
}
