import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { resolveSearchHistory } from '../../../../../../lib/release/m6Capabilities';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  return Response.json({ success: true, searchHistory: resolveSearchHistory() });
}
