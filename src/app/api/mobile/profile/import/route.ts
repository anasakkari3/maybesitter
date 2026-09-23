import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../../lib/consents/aiConsentService';
import { reserveDailyAction } from '../../../../../../lib/llm/usageGuard';
import { moduleDisabledResponse } from '../../../../../../lib/services/mobile/moduleGate';
import {
  ImportTextTooLongError,
  importAiContext,
} from '../../../../../../lib/services/mobile/aiContextImportService';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  MAX_IMPORTS_PER_DAY,
  isImportAssistant,
} from '../../../../../../src/profile/aiContextImportContracts';

export const dynamic = 'force-dynamic';

/**
 * Reads a profile another AI assistant wrote about the user, and proposes what
 * of it MaybeSitter might remember.
 *
 * ── Consent is checked here, before the service is called ────────
 *
 * The provider would refuse anyway — the gate is what makes it the only route
 * to a model (#161). This asks first so the *client* gets `consent_required`
 * rather than an empty list, because those mean different things on the screen:
 * one offers to turn AI on, the other says there was nothing to bring over.
 * Zero Vertex calls either way.
 *
 * ── The daily cap is reserved last of the three refusals ─────────
 *
 * After consent and after the length check, so a refusal never spends one of
 * the three attempts a user gets. An import is a bootstrap: three in a day
 * covers "tried ChatGPT, then Claude, then fixed a bad paste", and a fourth is
 * a loop rather than a person.
 *
 * ── The paste is in the request and nowhere else ─────────────────
 *
 * Not echoed in the response, not stored on the proposal, not in the audit
 * line. What comes back is the candidates, which is what the user is about to
 * be asked about.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  let body: { text?: unknown; assistant?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return mobileError('Invalid JSON request body');
  }

  if (!isImportAssistant(body?.assistant)) {
    return Response.json(
      { success: false, error: 'unknown assistant', reason: 'invalid_assistant' },
      { status: 400 },
    );
  }

  if (await getAiConsent(user.uid) !== 'granted') {
    return Response.json(
      { success: false, error: 'AI processing has not been agreed to', reason: 'consent_required' },
      { status: 403 },
    );
  }

  const text = String(body?.text ?? '');
  if (tooLong(text)) {
    const error = new ImportTextTooLongError();
    return Response.json(
      { success: false, error: error.message, reason: 'import_too_long', maxCharacters: error.maxCharacters },
      { status: 400 },
    );
  }

  // Fails closed: an unreadable counter refuses rather than waves the call
  // through, which is what the guard does everywhere else.
  const reservation = await reserveDailyAction(user.uid, 'ai_context_import', MAX_IMPORTS_PER_DAY);
  if (reservation !== 'ok') {
    return Response.json(
      {
        success: false,
        error: 'too many imports today',
        reason: 'import_rate_limited',
        maxPerDay: MAX_IMPORTS_PER_DAY,
      },
      { status: 429 },
    );
  }

  try {
    const proposal = await importAiContext(user.uid, text, body.assistant, new Date());
    return Response.json({ success: true, ...proposal });
  } catch (error) {
    if (error instanceof ImportTextTooLongError) {
      return Response.json(
        { success: false, error: error.message, reason: 'import_too_long', maxCharacters: error.maxCharacters },
        { status: 400 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'could not read the profile', 500);
  }
}

/**
 * Checked here as well as in the service so the daily cap is never spent on a
 * paste that was always going to be refused.
 */
function tooLong(text: string): boolean {
  return Array.from(text.trim()).length > new ImportTextTooLongError().maxCharacters;
}
