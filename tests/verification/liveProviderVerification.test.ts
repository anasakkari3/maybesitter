/**
 * The live provider verification harness, checked offline.
 *
 * Everything here runs with no network and no credentials. The harness's whole
 * purpose is to be safe to leave in the repository and trivial to skip, so the
 * properties worth testing are the refusals: what it does when it has no
 * credentials, no transport, a hostile error message, or a response the
 * production adapter rejects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_VERIFICATION_FLAG,
  ProviderProbeHttpError,
  liveVerificationEnabled,
  probesAreClean,
  redactSecrets,
  runProviderProbe,
  runProviderProbes,
  type ProbeResult,
  type ProviderProbe,
  type ProviderReadPort,
} from '../../lib/verification/liveProviderVerification.ts';
import {
  PROVIDERS_WITHOUT_LIVE_PROBES,
  PROVIDER_PROBES,
} from '../../lib/verification/providerProbeCatalog.ts';
import type { ContextProviderKind } from '../../src/contracts/v1/integrationConnectionContracts.ts';

const CREDS = { MAYBESITTER_LIVE_GOOGLE_ACCESS_TOKEN: 'present', [LIVE_VERIFICATION_FLAG]: '1' };

function gmailPage(over: Record<string, unknown> = {}) {
  return {
    historyId: '99',
    nextPageToken: null,
    messages: [
      {
        id: 'm1',
        threadId: 't1',
        historyId: '99',
        receivedAt: '2026-09-18T08:00:00.000Z',
        from: 'clinic@example.com',
        subject: 'Appointment',
        text: 'Your appointment is on Tuesday.',
      },
    ],
    ...over,
  };
}

function portReturning(value: unknown, provider: ContextProviderKind = 'google'): ProviderReadPort {
  return { provider, read: async () => value };
}

function portThrowing(error: Error, provider: ContextProviderKind = 'google'): ProviderReadPort {
  return {
    provider,
    read: async () => {
      throw error;
    },
  };
}

const gmailProbe = PROVIDER_PROBES.find((probe) => probe.operation === 'gmail.history.list')!;

function ports(port: ProviderReadPort): ReadonlyMap<ContextProviderKind, ProviderReadPort> {
  return new Map([[port.provider, port]]);
}

test('a real-shaped response passes through the production adapter and validates', async () => {
  const result = await runProviderProbe(gmailProbe, {
    env: CREDS,
    ports: ports(portReturning(gmailPage())),
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.contractValidated, true);
  assert.equal(result.recordCount, 1);
  assert.equal(result.failureCategory, null);
});

test('a response the adapter rejects is CONTRACT_MISMATCH, not a pass', async () => {
  // A drifted Gmail message: `receivedAt` is no longer a date. This is the
  // drift the harness exists to catch, and `normalizeGmailMessage` is what
  // notices — the probe does no parsing of its own.
  const drifted = gmailPage({
    messages: [{ ...gmailPage().messages[0], receivedAt: 'not-a-date' }],
  });
  const result = await runProviderProbe(gmailProbe, {
    env: CREDS,
    ports: ports(portReturning(drifted)),
  });
  assert.equal(result.status, 'CONTRACT_MISMATCH');
  assert.equal(result.contractValidated, false);
  assert.equal(result.failureCategory, 'malformed_response');
});

test('missing credentials skip cleanly and name only the variable', async () => {
  const result = await runProviderProbe(gmailProbe, {
    env: { [LIVE_VERIFICATION_FLAG]: '1' },
    ports: ports(portReturning(gmailPage())),
  });
  assert.equal(result.status, 'SKIPPED_MISSING_CREDENTIALS');
  assert.match(result.detail ?? '', /MAYBESITTER_LIVE_GOOGLE_ACCESS_TOKEN/);
  assert.equal(result.contractValidated, false);
  assert.ok(probesAreClean([result]), 'a missing credential is not a failure');
});

test('a credential set to whitespace counts as missing', async () => {
  const result = await runProviderProbe(gmailProbe, {
    env: { ...CREDS, MAYBESITTER_LIVE_GOOGLE_ACCESS_TOKEN: '   ' },
    ports: ports(portReturning(gmailPage())),
  });
  assert.equal(result.status, 'SKIPPED_MISSING_CREDENTIALS');
});

test('no registered port is an explicit unsupported skip', async () => {
  const result = await runProviderProbe(gmailProbe, { env: CREDS, ports: new Map() });
  assert.equal(result.status, 'SKIPPED_UNSUPPORTED_LIVE_PROBE');
  assert.match(result.detail ?? '', /no read port registered/);
});

test('401 is AUTH_FAILED and 403 is SCOPE_INSUFFICIENT', async () => {
  const auth = await runProviderProbe(gmailProbe, {
    env: CREDS,
    ports: ports(portThrowing(new ProviderProbeHttpError(401))),
  });
  assert.equal(auth.status, 'AUTH_FAILED');
  assert.equal(auth.failureCategory, 'authentication_revoked');

  const scope = await runProviderProbe(gmailProbe, {
    env: CREDS,
    ports: ports(portThrowing(new ProviderProbeHttpError(403))),
  });
  assert.equal(scope.status, 'SCOPE_INSUFFICIENT');
  assert.equal(scope.failureCategory, 'permission_lost');
});

test('a rate limit is PROVIDER_ERROR carrying the canonical category', async () => {
  const result = await runProviderProbe(gmailProbe, {
    env: CREDS,
    ports: ports(portThrowing(new ProviderProbeHttpError(429))),
  });
  assert.equal(result.status, 'PROVIDER_ERROR');
  assert.equal(result.failureCategory, 'rate_limited');
});

test('a 500 is PROVIDER_ERROR, not a contract mismatch', async () => {
  const result = await runProviderProbe(gmailProbe, {
    env: CREDS,
    ports: ports(portThrowing(new ProviderProbeHttpError(503))),
  });
  assert.equal(result.status, 'PROVIDER_ERROR');
  assert.equal(result.failureCategory, 'provider_unavailable');
});

test('secrets in a provider error never reach the result', async () => {
  const nasty = new Error(
    'refused for Authorization: Bearer ya29.a0AfB_secretvalue and refresh_token=1//0gSECRETrefresh',
  );
  const result = await runProviderProbe(gmailProbe, {
    env: CREDS,
    ports: ports(portThrowing(nasty)),
  });
  const detail = result.detail ?? '';
  assert.ok(!detail.includes('ya29.a0AfB_secretvalue'), `token leaked: ${detail}`);
  assert.ok(!detail.includes('1//0gSECRETrefresh'), `refresh token leaked: ${detail}`);
  assert.match(detail, /\[redacted\]/);
});

test('redaction covers bearer tokens, JWTs, api keys and client secrets', () => {
  const cases = [
    'Authorization: Bearer abc.def-ghi',
    'access_token: "ya29.verysecret"',
    'client_secret=GOCSPX-abcdefghijklmnop',
    'api_key: rt_live_abcdef123456',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
  ];
  for (const value of cases) {
    const out = redactSecrets(value);
    assert.match(out, /\[redacted\]/, `not redacted: ${value} -> ${out}`);
  }
});

test('redaction truncates after redacting, so nothing survives past the cut', () => {
  const out = redactSecrets(`${'x'.repeat(400)} Bearer supersecrettoken`);
  assert.ok(!out.includes('supersecrettoken'));
  assert.ok(out.length <= 201);
});

test('a probe can only ever call read: the port exposes no other verb', async () => {
  const called: string[] = [];
  const recording: ProviderReadPort = {
    provider: 'google',
    read: async (request) => {
      called.push(`read:${request.operation}`);
      assert.ok(request.limit > 0 && request.limit <= 25, 'the sample must stay bounded');
      return gmailPage();
    },
  };
  await runProviderProbe(gmailProbe, { env: CREDS, ports: ports(recording) });
  assert.deepEqual(called, ['read:gmail.history.list']);
  // Structural, not a convention: there is no second method to reach.
  assert.deepEqual(
    Object.keys(recording).filter((key) => typeof (recording as never)[key] === 'function'),
    ['read'],
  );
});

test('every catalogued probe is read-only and bounded', () => {
  assert.ok(PROVIDER_PROBES.length > 0);
  for (const probe of PROVIDER_PROBES) {
    assert.equal(probe.readOnly, true, `${probe.operation} is not read-only`);
    assert.ok(probe.limit > 0 && probe.limit <= 25, `${probe.operation} is unbounded`);
    assert.ok(probe.credentialEnvVars.length > 0, `${probe.operation} is not credential gated`);
    assert.match(probe.operation, /^[a-z]+\.[a-z.]+$/);
  }
});

test('a probe that is not read-only is refused before anything is contacted', async () => {
  let contacted = false;
  const sneaky = { ...gmailProbe, readOnly: false } as unknown as ProviderProbe;
  const result = await runProviderProbe(sneaky, {
    env: CREDS,
    ports: ports({
      provider: 'google',
      read: async () => {
        contacted = true;
        return gmailPage();
      },
    }),
  });
  assert.equal(result.status, 'SKIPPED_UNSUPPORTED_LIVE_PROBE');
  assert.equal(contacted, false, 'a non-read-only probe reached the provider');
});

test('an unknown provider has no port and is refused', async () => {
  const unknown = { ...gmailProbe, provider: 'not-a-provider' as ContextProviderKind };
  const result = await runProviderProbe(unknown, {
    env: CREDS,
    ports: ports(portReturning(gmailPage())),
  });
  assert.equal(result.status, 'SKIPPED_UNSUPPORTED_LIVE_PROBE');
});

test('without the opt-in flag nothing is contacted at all', async () => {
  let contacted = false;
  const results = await runProviderProbes(PROVIDER_PROBES, {
    env: { MAYBESITTER_LIVE_GOOGLE_ACCESS_TOKEN: 'present' },
    ports: ports({
      provider: 'google',
      read: async () => {
        contacted = true;
        return gmailPage();
      },
    }),
  });
  assert.equal(contacted, false, 'a provider was contacted without the opt-in flag');
  assert.equal(results.length, PROVIDER_PROBES.length);
  assert.ok(results.every((entry: ProbeResult) => entry.status === 'SKIPPED_UNSUPPORTED_LIVE_PROBE'));
  assert.ok(probesAreClean(results));
});

test('the flag is off unless it is exactly 1', () => {
  assert.equal(liveVerificationEnabled({}), false);
  assert.equal(liveVerificationEnabled({ [LIVE_VERIFICATION_FLAG]: 'true' }), false);
  assert.equal(liveVerificationEnabled({ [LIVE_VERIFICATION_FLAG]: '0' }), false);
  assert.equal(liveVerificationEnabled({ [LIVE_VERIFICATION_FLAG]: '1' }), true);
});

test('the default run, as CI would do it, contacts nothing and is clean', async () => {
  const results = await runProviderProbes(PROVIDER_PROBES, { env: {} });
  assert.ok(probesAreClean(results));
  assert.ok(results.every((entry) => !entry.contractValidated));
});

test('a failure is not clean', () => {
  const failing = [{ status: 'CONTRACT_MISMATCH' } as ProbeResult];
  assert.equal(probesAreClean(failing), false);
});

test('the providers this harness cannot cover are recorded with a reason', () => {
  const named = PROVIDERS_WITHOUT_LIVE_PROBES.map((entry) => entry.provider);
  for (const expected of ['todoist', 'notion', 'whoop', 'revenuecat']) {
    assert.ok(named.includes(expected), `${expected} must be explained, not silently missing`);
  }
  for (const entry of PROVIDERS_WITHOUT_LIVE_PROBES) {
    assert.ok(entry.reason.length > 40, `${entry.provider} needs a real reason`);
  }
});

test('no result field can carry provider content', async () => {
  const result = await runProviderProbe(gmailProbe, {
    env: CREDS,
    ports: ports(portReturning(gmailPage())),
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('Your appointment is on Tuesday'), 'message body leaked');
  assert.ok(!serialized.includes('clinic@example.com'), 'sender leaked');
  assert.ok(!serialized.includes('Appointment'), 'subject leaked');
});
