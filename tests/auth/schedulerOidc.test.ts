import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIENCE_ENV_VAR,
  SCHEDULER_SA_ENV_VAR,
  authorizeSchedulerRequest,
  bearerToken,
  schedulerAuthConfig,
  schedulerAuthErrorResponse,
  type OidcPayload,
} from '../../lib/auth/schedulerOidc';

// `/api/internal/jobs/*` runs work for every user on a service that is
// reachable from the internet, so the interesting cases here are all the ways
// a caller that is not Cloud Scheduler must be refused.

const SA = 'maybesitter-scheduler@example-project.iam.gserviceaccount.com';
const AUDIENCE = 'https://api.example.invalid';

// `NODE_ENV` is required on this repo's `ProcessEnv`, so it is spelled out
// rather than cast away.
const ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test', [SCHEDULER_SA_ENV_VAR]: SA, [AUDIENCE_ENV_VAR]: AUDIENCE };

function requestWith(authorization: string | null) {
  return { headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : null) } };
}

/** A verifier that returns the given claims, and records what it was asked. */
function verifierReturning(payload: OidcPayload) {
  const calls: Array<{ token: string; audience: string }> = [];
  return {
    calls,
    verify: async (token: string, audience: string) => {
      calls.push({ token, audience });
      return payload;
    },
  };
}

const googlePayload: OidcPayload = {
  email: SA,
  email_verified: true,
  aud: AUDIENCE,
  iss: 'https://accounts.google.com',
};

test('the scheduler service account is authorized', async () => {
  const verifier = verifierReturning(googlePayload);
  const result = await authorizeSchedulerRequest(requestWith('Bearer token-abc'), {
    env: ENV,
    verify: verifier.verify,
  });
  assert.deepEqual(result, { ok: true, caller: SA });
  // The audience the token is checked against is the service's own URL, which
  // is what stops a staging token being replayed against production.
  assert.deepEqual(verifier.calls, [{ token: 'token-abc', audience: AUDIENCE }]);
});

test('a token from a different service account is refused with 403', async () => {
  // Any Google Cloud customer can mint a validly signed OIDC token. Signature
  // alone is authentication, not authorization.
  const verifier = verifierReturning({ ...googlePayload, email: 'someone-else@other-project.iam.gserviceaccount.com' });
  const result = await authorizeSchedulerRequest(requestWith('Bearer t'), { env: ENV, verify: verifier.verify });
  assert.deepEqual(result, { ok: false, code: 'wrong_caller', status: 403 });
});

test('an unverified email is refused even with the right address', async () => {
  const verifier = verifierReturning({ ...googlePayload, email_verified: false });
  const result = await authorizeSchedulerRequest(requestWith('Bearer t'), { env: ENV, verify: verifier.verify });
  assert.deepEqual(result, { ok: false, code: 'wrong_caller', status: 403 });
});

test('a token minted for another audience is refused', async () => {
  const verifier = verifierReturning({ ...googlePayload, aud: 'https://staging.example.invalid' });
  const result = await authorizeSchedulerRequest(requestWith('Bearer t'), { env: ENV, verify: verifier.verify });
  assert.deepEqual(result, { ok: false, code: 'wrong_audience', status: 401 });
});

test('a token from a non-Google issuer is refused', async () => {
  const verifier = verifierReturning({ ...googlePayload, iss: 'https://accounts.evil.invalid' });
  const result = await authorizeSchedulerRequest(requestWith('Bearer t'), { env: ENV, verify: verifier.verify });
  assert.deepEqual(result, { ok: false, code: 'invalid_token', status: 401 });
});

test('a rejected signature is refused, and the reason is not passed on', async () => {
  const result = await authorizeSchedulerRequest(requestWith('Bearer t'), {
    env: ENV,
    verify: async () => {
      throw new Error('Token used too late, 1970-01-01T00:00:00Z');
    },
  });
  assert.deepEqual(result, { ok: false, code: 'invalid_token', status: 401 });
});

test('no Authorization header is refused before any verification happens', async () => {
  const verifier = verifierReturning(googlePayload);
  const result = await authorizeSchedulerRequest(requestWith(null), { env: ENV, verify: verifier.verify });
  assert.deepEqual(result, { ok: false, code: 'missing_token', status: 401 });
  assert.deepEqual(verifier.calls, []);
});

test('a non-Bearer Authorization header is not treated as a token', async () => {
  for (const header of ['Basic abc', 'Bearer', 'Bearer ', 'bearer-token', 'Bearer a b']) {
    const result = await authorizeSchedulerRequest(requestWith(header), {
      env: ENV,
      verify: async () => googlePayload,
    });
    assert.deepEqual(result, { ok: false, code: 'missing_token', status: 401 }, `header: ${JSON.stringify(header)}`);
  }
});

test('missing configuration answers 503 and never verifies, rather than allowing', async () => {
  // A deployment that forgot the env vars must not become an open endpoint.
  const verifier = verifierReturning(googlePayload);
  const partials: NodeJS.ProcessEnv[] = [
    { NODE_ENV: 'test' },
    { NODE_ENV: 'test', [SCHEDULER_SA_ENV_VAR]: SA },
    { NODE_ENV: 'test', [AUDIENCE_ENV_VAR]: AUDIENCE },
  ];
  for (const env of partials) {
    const result = await authorizeSchedulerRequest(requestWith('Bearer t'), { env, verify: verifier.verify });
    assert.deepEqual(result, { ok: false, code: 'not_configured', status: 503 });
  }
  assert.deepEqual(verifier.calls, []);
});

test('blank configuration counts as missing, not as an empty expected caller', async () => {
  assert.equal(schedulerAuthConfig({ NODE_ENV: 'test', [SCHEDULER_SA_ENV_VAR]: '  ', [AUDIENCE_ENV_VAR]: AUDIENCE }), null);
  assert.deepEqual(schedulerAuthConfig(ENV), { serviceAccountEmail: SA, audience: AUDIENCE });
});

test('bearerToken reads exactly one token', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('  Bearer   abc  '), 'abc');
  assert.equal(bearerToken(null), null);
  assert.equal(bearerToken(''), null);
  assert.equal(bearerToken('Bearer abc def'), null);
});

test('the refusal body carries the code and nothing else', async () => {
  const response = schedulerAuthErrorResponse({ code: 'wrong_caller', status: 403 });
  assert.equal(response.status, 403);
  // Asserting the whole body proves no token, expected caller or audience
  // rides along to tell a prober what would have been accepted.
  assert.deepEqual(await response.json(), { error: 'wrong_caller' });
});
