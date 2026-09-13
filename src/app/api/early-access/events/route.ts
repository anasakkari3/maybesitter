import { handleEarlyAccess } from '../../../../../lib/earlyAccess/service';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request) { return handleEarlyAccess(request); }
