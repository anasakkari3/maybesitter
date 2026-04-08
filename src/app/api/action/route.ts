import type { DailyDigest, User } from '@/types';
import {
  resetSingleUserAccount,
  updateLegacyMetadata,
} from '../../../../lib/services/appMetadataService';
import { getUnifiedAppSnapshot } from '../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

type AppActionBody = {
  type?: string;
  user?: Partial<User>;
  digest?: DailyDigest;
};

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let body: AppActionBody;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body');
  }

  try {
    switch (body.type) {
      case 'updateUser':
      case 'setDailyDigest':
      case 'confirmDailyDigest':
        await updateLegacyMetadata({ type: body.type, user: body.user, digest: body.digest });
        break;
      case 'deleteAccount':
        await resetSingleUserAccount();
        break;
      default:
        throw new Error(`Unsupported action: ${body.type}`);
    }

    return Response.json(await getUnifiedAppSnapshot());
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Action failed');
  }
}
