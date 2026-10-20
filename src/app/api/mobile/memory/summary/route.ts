import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { resolveMemoryLearning } from '../../../../../../lib/release/m5bCapabilities';
import { MEMORY_SUMMARY_ROUTE_BUDGET_MS, buildMemorySummary, type MemorySummaryLanguage } from '../../../../../../lib/services/mobile/memorySummary';
import { moduleDisabledResponse } from '../../../../../../lib/services/mobile/moduleGate';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let user;
  try { user = await requireMobileUser(request); }
  catch (error) { return mobileAuthErrorResponse(error); }
  if (!resolveMemoryLearning()) return Response.json({ success: false, error: 'm5b_unavailable' }, { status: 404 });
  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;
  const language = new URL(request.url).searchParams.get('language');
  if (language !== 'ar' && language !== 'en' && language !== 'he') {
    return Response.json({ success: false, error: 'language must be ar, en, or he' }, { status: 400 });
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  const elapsed = Date.now() - startedAt;
  const budget = setTimeout(abort, Math.max(0, MEMORY_SUMMARY_ROUTE_BUDGET_MS - elapsed));
  try {
    const work = buildMemorySummary({ uid: user.uid, language: language as MemorySummaryLanguage, signal: controller.signal, abort, startedAt });
    const summary = await Promise.race([
      work,
      new Promise<{ status: 'unavailable' }>((resolve) => controller.signal.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true })),
    ]);
    return Response.json({ success: true, summary });
  } finally {
    clearTimeout(budget);
    request.signal.removeEventListener('abort', abort);
  }
}
