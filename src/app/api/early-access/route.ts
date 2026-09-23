import { handleEarlyAccess } from '../../../../lib/earlyAccess/service';

// The website's tester sign-up (site/SIGNUP_CONTRACT.md). POST only; Next answers
// 405 for every other verb. There is deliberately no `/events` sibling: the
// site sends no page views.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return handleEarlyAccess(request);
}
