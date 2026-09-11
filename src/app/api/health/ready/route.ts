import { getStorage } from '../../../../../lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Readiness, as distinct from liveness (`/api/health`).
 *
 * Cloud Run's startup probe points here: an instance is only ready once it can
 * actually reach storage, otherwise the deploy would send traffic to a service
 * that answers requests by losing data. The check is a single tiny read with a
 * short timeout, so a probe every five seconds costs nothing.
 *
 * The failure reason is deliberately coarse. A probe response is public, and
 * "storage_unavailable" is all an operator needs; the real error goes to the
 * log.
 */
const PROBE_TIMEOUT_MS = 2_000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`storage probe exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  try {
    await withTimeout(getStorage().get('_health/probe'), PROBE_TIMEOUT_MS);
    return Response.json({ ready: true });
  } catch (error) {
    console.error('[health/ready] storage probe failed', error);
    return Response.json({ ready: false, reason: 'storage_unavailable' }, { status: 503 });
  }
}
