import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { resolveMemoryLearning } from '../../../../../../lib/release/m5bCapabilities';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  return Response.json({ success: true, memoryLearning: resolveMemoryLearning() });
}
