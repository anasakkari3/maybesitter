import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import {
  MemorySuggestionConsentError,
  MemorySuggestionStaleError,
  MemorySuggestionValidationError,
  UnknownMemoryRuleError,
  decideMemorySuggestion,
} from '../../../../../../../lib/memoryGrowth/suggestionService';
import { moduleDisabledResponse } from '../../../../../../../lib/services/mobile/moduleGate';
import { mobileError } from '../../../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ ruleId: string }>;
}

/**
 * Keep, or "Not right", for one suggestion (UC-3.16, #202).
 *
 * Body: `{ decision: 'keep' | 'dismiss', fingerprint, language }`, where
 * `language` is required for `keep` and is the language the kept sentence is
 * stored in. Nothing else in the body is read: what Keep stores is recomputed
 * from the rule on the server.
 *
 * 201 with the new record for `keep`; 200 for `dismiss`. 409
 * `memory_suggestion_stale` when the fingerprint is not one the server would
 * suggest now; 403 `personalization_consent_required` without consent.
 */
export async function POST(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  let body: { decision?: unknown; fingerprint?: unknown; language?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return mobileError('Invalid JSON request body');
  }

  const { ruleId } = await context.params;
  try {
    const outcome = await decideMemorySuggestion(
      user.uid,
      ruleId,
      { decision: body?.decision, fingerprint: body?.fingerprint, language: body?.language },
      new Date().toISOString(),
    );
    if (outcome.decision === 'keep') {
      return Response.json({ success: true, decision: 'keep', memory: outcome.memory }, { status: 201 });
    }
    return Response.json({ success: true, decision: 'dismiss' });
  } catch (error) {
    if (error instanceof UnknownMemoryRuleError) {
      return Response.json({ success: false, error: error.message, reason: 'memory_rule_not_found' }, { status: 404 });
    }
    if (error instanceof MemorySuggestionValidationError) {
      return Response.json({ success: false, error: error.message, reason: 'invalid_memory_suggestion' }, { status: 400 });
    }
    if (error instanceof MemorySuggestionConsentError) {
      return Response.json(
        { success: false, error: error.message, reason: 'personalization_consent_required' },
        { status: 403 },
      );
    }
    if (error instanceof MemorySuggestionStaleError) {
      return Response.json({ success: false, error: error.message, reason: 'memory_suggestion_stale' }, { status: 409 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not answer the suggestion', 500);
  }
}
