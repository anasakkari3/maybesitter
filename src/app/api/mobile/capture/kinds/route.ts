import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { resolveCaptureKinds } from '../../../../../../lib/services/captureKinds/runtime';
import { resolveModuleRuntime } from '../../../../../contracts/v1/runtimeControls';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  if (!resolveCaptureKinds()) {
    return Response.json({ success: false, error: 'not found', reason: 'feature_unavailable' }, { status: 404 });
  }
  const entries: Array<'goal' | 'habit' | 'thought'> = ['habit', 'thought'];
  if (resolveModuleRuntime('memory').mode === 'enabled') entries.unshift('goal');
  return Response.json({ success: true, entries });
}
