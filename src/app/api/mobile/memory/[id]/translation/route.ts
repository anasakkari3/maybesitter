import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { resolveMemoryTranslation } from '../../../../../../../lib/release/m6Capabilities';
import {
  MEMORY_TRANSLATION_ROUTE_BUDGET_MS,
  MemoryTranslationEligibilityError,
  proposeMemoryTranslation,
  type MemoryTranslationLanguage,
} from '../../../../../../../lib/services/mobile/memoryTranslation';
import { MemoryNotFoundError } from '../../../../../../../lib/services/mobile/memoryService';
import { moduleDisabledResponse } from '../../../../../../../lib/services/mobile/moduleGate';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import {
  RequestBodyTooLargeError,
  readJsonBody,
  requestBodyTooLargeResponse,
} from '../../../../../../../lib/net/requestBody';
import { MEMORY_TRANSLATION_DISCLOSURE_VERSION } from '../../../../../../../src/contracts/v1/consentContracts';

export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string }> }

function featureUnavailable(): Response {
  return Response.json({ success: false, error: 'feature_unavailable', reason: 'feature_unavailable' }, { status: 404 });
}

function notFound(): Response {
  return Response.json({ success: false, error: 'not found', reason: 'memory_not_found' }, { status: 404 });
}

function eligibility(reason: 'not_translatable' | 'already_in_language'): Response {
  return Response.json({ success: false, error: reason, reason }, { status: 422 });
}

function parseBody(value: unknown): { locale: MemoryTranslationLanguage; disclosureVersion: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== 'disclosureVersion' || keys[1] !== 'locale') return null;
  if (body.locale !== 'ar' && body.locale !== 'en' && body.locale !== 'he') return null;
  if (body.disclosureVersion !== MEMORY_TRANSLATION_DISCLOSURE_VERSION) return null;
  return { locale: body.locale, disclosureVersion: body.disclosureVersion };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const startedAt = Date.now();
  let user;
  try { user = await requireMobileUser(request); }
  catch (error) { return mobileAuthErrorResponse(error); }

  if (!resolveMemoryTranslation()) return featureUnavailable();
  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  let raw: unknown;
  try { raw = await readJsonBody(request, { limitBytes: 1024 }); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }
  const body = parseBody(raw);
  if (!body) return mobileError('Invalid memory translation request');

  const { id } = await context.params;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });
  const budget = setTimeout(abort, Math.max(0, MEMORY_TRANSLATION_ROUTE_BUDGET_MS - (Date.now() - startedAt)));
  try {
    const work = proposeMemoryTranslation({
      uid: user.uid,
      memoryId: id,
      locale: body.locale,
      now: new Date().toISOString(),
      signal: controller.signal,
      abort,
      startedAt,
    });
    const proposal = await Promise.race([
      work,
      new Promise<{ status: 'unavailable' }>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true });
      }),
    ]);
    return Response.json({ success: true, proposal });
  } catch (error) {
    if (error instanceof MemoryNotFoundError) return notFound();
    if (error instanceof MemoryTranslationEligibilityError) return eligibility(error.reason);
    return mobileError('could not translate the memory', 500);
  } finally {
    clearTimeout(budget);
    request.signal.removeEventListener('abort', abort);
  }
}
