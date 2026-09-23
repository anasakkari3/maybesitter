/**
 * What production serves, and what it does not (UC-1.0e, #144).
 *
 * The middleware is the thing that makes the remaining file-backed, URL-id
 * legacy routes unreachable on Cloud Run. `/api/state` and `/api/pilot/trust`
 * both take an identity from the request rather than from a token, so "they
 * are 404 in production" is the property, and it is asserted rather than
 * assumed from the matcher.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isProductionPath, middleware } from '../../src/middleware.ts';

function requestFor(path: string): Request {
  return new Request(`https://api.maybesitter.example${path}`);
}

function withCloudRun<T>(run: () => T): T {
  const previous = process.env.K_SERVICE;
  process.env.K_SERVICE = 'maybesitter-api';
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = previous;
  }
}

function withoutCloudRun<T>(run: () => T): T {
  const previous = process.env.K_SERVICE;
  delete process.env.K_SERVICE;
  try {
    return run();
  } finally {
    if (previous !== undefined) process.env.K_SERVICE = previous;
  }
}

const BLOCKED_IN_PRODUCTION = [
  '/api/state',
  '/api/pilot/trust',
  '/api/pilot/incidents',
  '/api/next-step',
  '/api/calendar.ics',
  '/api/analytics',
  '/api/capture',
  '/api/agenda',
  '/api/release',
  '/api/dev/seed-demo',
  '/api/reminders/run',
  // The stranded launch build had a page-view endpoint here. The site sends no
  // page views, so it must not come back by accident.
  '/api/early-access/events',
  '/api/early-accessx',
  '/',
  '/assistant',
];

const SERVED_IN_PRODUCTION = [
  '/api/health',
  '/api/mobile/capture',
  '/api/mobile/capture/confirm',
  '/api/mobile/commitments/today',
  '/api/mobile/feedback/history',
  '/api/mobile/pilot/trust',
  '/api/internal/anything',
  '/api/early-access',
];

test('on Cloud Run the legacy surface is 404, including the URL-id routes', () => {
  withCloudRun(() => {
    for (const path of BLOCKED_IN_PRODUCTION) {
      assert.equal(middleware(requestFor(path))?.status, 404, `${path} must not be served in production`);
    }
  });
});

test('on Cloud Run the mobile API, health and internal paths are served', () => {
  withCloudRun(() => {
    for (const path of SERVED_IN_PRODUCTION) {
      // Nothing returned: the request continues to its route.
      assert.equal(middleware(requestFor(path)), undefined, `${path} must be served in production`);
    }
  });
});

test('off Cloud Run nothing is blocked, so local development is unaffected', () => {
  withoutCloudRun(() => {
    for (const path of [...BLOCKED_IN_PRODUCTION, ...SERVED_IN_PRODUCTION]) {
      assert.equal(middleware(requestFor(path)), undefined, `${path} must be reachable locally`);
    }
  });
});

test('a path that merely starts with an allowed word is not allowed', () => {
  // `/api/mobilex` and `/api/internalise` are not the mobile or internal APIs.
  assert.equal(isProductionPath('/api/mobilex/capture'), false);
  assert.equal(isProductionPath('/api/internalise'), false);
  assert.equal(isProductionPath('/api/mobile'), true);
  assert.equal(isProductionPath('/api/mobile/capture'), true);
  // `/api/health*` covers the readiness variants the platform may probe.
  assert.equal(isProductionPath('/api/health'), true);
  assert.equal(isProductionPath('/api/healthz'), true);
});

test('the blocked answer is an empty 404, not a 403 that confirms the route', async () => {
  await withCloudRun(async () => {
    const response = middleware(requestFor('/api/state'));
    assert.equal(response?.status, 404);
    assert.equal(await response?.text(), '');
  });
});
