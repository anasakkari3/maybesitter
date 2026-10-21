import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { resolveMemoryTranslation } from '../../../../../../lib/release/m6Capabilities';
import { MEMORY_TRANSLATION_DISCLOSURE_VERSION } from '../../../../../../src/contracts/v1/consentContracts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  return Response.json({
    success: true,
    memoryTranslation: resolveMemoryTranslation(),
    disclosureVersion: MEMORY_TRANSLATION_DISCLOSURE_VERSION,
  });
}
