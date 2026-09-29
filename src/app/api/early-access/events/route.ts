import { handleEarlyAccessEvent } from '../../../../../lib/earlyAccess/service';

// The stranded launch page's page-view ping, kept only so the page still live
// on Hosting gets an answer after main reaches production. It counts nothing:
// a 204 that reads no body (lib/earlyAccess/service.ts, `handleEarlyAccessEvent`).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return handleEarlyAccessEvent(request);
}
