import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

// One id per process, so a caller can tell instances apart. UC-1.9 (#153)
// counts distinct values to prove more than one instance served its writes,
// and the deploy workflow checks `commit` to confirm what it just promoted.
const instanceId = randomUUID();

export async function GET() {
  return Response.json({
    status: 'ok',
    service: 'maybesitter-api',
    revision: process.env.K_REVISION ?? null,
    commit: process.env.MAYBESITTER_GIT_SHA ?? null,
    instanceId,
    timestamp: new Date().toISOString(),
  });
}
