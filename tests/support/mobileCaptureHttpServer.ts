/**
 * Test-only HTTP host for the real mobile route handlers. Firebase verification
 * and storage are isolated here; neither seam is reachable from app config.
 * Started as a child process by captureHttpIntegration.test.tsx, with
 * isolateProcess.mjs providing a disposable data directory.
 */
import { createServer } from 'node:http';
import { installFakeAuth, tokenFor, uidFor } from './fakeAuth.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { POST as propose } from '../../src/app/api/mobile/capture/route.ts';
import { POST as clarify } from '../../src/app/api/mobile/capture/clarify/route.ts';
import { POST as confirm } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as today } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcoming } from '../../src/app/api/mobile/commitments/upcoming/route.ts';
import { GET as consents } from '../../src/app/api/mobile/consents/route.ts';
import { GET as trust } from '../../src/app/api/mobile/pilot/trust/route.ts';

// An unexpected provider call must fail locally, even on a developer machine
// with credentials. The browser/device-facing requests arrive through HTTP.
globalThis.fetch = async () => { throw new Error('External network disabled in capture HTTP tests'); };
setStorageForTests(createMemoryStorage());
const auth = installFakeAuth();
const uid = uidFor('CaptureHttpUser');
const otherUid = uidFor('OtherCaptureHttpUser');
const routes = new Map<string, (request: Request) => Promise<Response>>([
  ['POST /api/mobile/capture', propose],
  ['POST /api/mobile/capture/clarify', clarify],
  ['POST /api/mobile/capture/confirm', confirm],
  ['GET /api/mobile/commitments/today', today],
  ['GET /api/mobile/commitments/upcoming', upcoming],
  ['GET /api/mobile/consents', consents],
  ['GET /api/mobile/pilot/trust', trust],
]);
const requests: Array<{ method: string; path: string; status: number }> = [];

const server = createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method ?? 'GET';
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    const handler = routes.get(`${method} ${url.pathname}`);
    if (!handler) {
      outgoing.writeHead(404, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Outside capture integration scope' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const request = new Request(url, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: Buffer.concat(chunks).toString('utf8') }),
    });
    const response = await handler(request);
    requests.push({ method, path: url.pathname, status: response.status });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(await response.text());
  } catch {
    outgoing.writeHead(500, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'Capture integration handler failed' }));
  }
});

let closing = false;
function close(): void {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close(() => {
    auth.restore();
    resetStorageForTests();
    process.exit(0);
  });
}
process.on('disconnect', close);
process.on('SIGTERM', close);
process.on('message', async (message: unknown) => {
  const command = message as { type?: string; id?: number; uid?: string };
  if (command.type === 'close') return close();
  if (command.type !== 'snapshot' || typeof command.id !== 'number') return;
  // Only the two synthetic accounts owned by this process may be inspected.
  if (command.uid !== uid && command.uid !== otherUid) return;
  try {
    const state = await getParticipantStateSnapshot(command.uid);
    process.send?.({
      type: 'snapshot', id: command.id,
      commitments: Object.values(state.commitments).map(item => ({
        id: item.id, title: item.title, status: item.status, priority: item.priority.level,
      })),
      requests,
    });
  } catch {
    process.send?.({ type: 'snapshot', id: command.id, error: 'Snapshot failed' });
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local TCP listener');
  process.send?.({ type: 'ready', baseUrl: `http://127.0.0.1:${address.port}`, uid, token: tokenFor(uid), otherUid, otherToken: tokenFor(otherUid) });
});
