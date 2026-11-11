import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { getFeatures, setFeatureEnabled } from '../endpoints/features';
import { ContractError, NotFoundError, ValidationError } from '../errors';
import { featureCapabilitiesSchema } from '../schemas/features';

/**
 * `/api/mobile/capabilities/features`: each call against the fixture its own
 * route produced, the refusals the route names, and a schema that lets a newer
 * server add a feature or a reason without breaking an installed app.
 */

const FIXTURES = join(__dirname, '..', '__fixtures__');
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

let requests: { url: string; method: string; body: unknown }[] = [];

function serve(body: unknown, status = 200): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method as string, body: init.body === undefined ? undefined : JSON.parse(init.body as string) });
    return { status, text: async () => JSON.stringify(body), headers: { get: () => null } };
  }) as never;
}

beforeEach(() => {
  requests = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'u1', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('reading the features', () => {
  it('asks the capabilities route and parses what it answered', async () => {
    serve(fixture('capabilities.features.enforce'));
    const body = await getFeatures({ asUid: 'u1' });
    expect(requests).toEqual([{ url: 'http://localhost:3000/api/mobile/capabilities/features', method: 'GET', body: undefined }]);
    expect(body.mode).toBe('enforce');
    expect(body.features[0]).toEqual({ id: 'assistant', tier: 'core', enabled: true, reason: 'free_allowance', userCanDisable: false, usedPercent: 0 });
  });

  it('parses the gate-off answer', async () => {
    serve(fixture('capabilities.features.off'));
    expect((await getFeatures()).mode).toBe('off');
  });
});

describe('switching one', () => {
  it('sends only the switch, to the feature’s own path, and returns the whole list', async () => {
    serve(fixture('capabilities.features.switched'));
    const body = await setFeatureEnabled('football', false);
    expect(requests).toEqual([{ url: 'http://localhost:3000/api/mobile/capabilities/features/football', method: 'PUT', body: { enabled: false } }]);
    expect(body.features.find(feature => feature.id === 'football')).toMatchObject({ enabled: false, reason: 'user_off' });
  });

  it('encodes the id into the path', async () => {
    serve(fixture('capabilities.features.switched'));
    await setFeatureEnabled('a/b', true);
    expect(requests[0]!.url).toBe('http://localhost:3000/api/mobile/capabilities/features/a%2Fb');
  });

  it('is refused for a core feature', async () => {
    serve({ success: false, error: 'not switchable', reason: 'not_switchable' }, 400);
    await expect(setFeatureEnabled('assistant', false)).rejects.toBeInstanceOf(ValidationError);
  });

  it('is a not-found for an id the server does not know', async () => {
    serve({ success: false, error: 'unknown feature', reason: 'unknown_feature' }, 404);
    await expect(setFeatureEnabled('nope', true)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the schema', () => {
  it('accepts a feature id and a reason this build has never heard of', () => {
    const body = fixture('capabilities.features.enforce');
    const features = [...(body.features as unknown[]), { id: 'time_travel', tier: 'addon', enabled: false, reason: 'solar_flare', userCanDisable: true, usedPercent: null }];
    expect(featureCapabilitiesSchema.safeParse({ ...body, features }).success).toBe(true);
  });

  it('is strict: a key the contract does not name is a contract change, not noise', () => {
    const body = fixture('capabilities.features.enforce');
    expect(featureCapabilitiesSchema.safeParse({ ...body, priceCents: 499 }).success).toBe(false);
    const features = (body.features as Record<string, unknown>[]).map((feature, i) => (i === 0 ? { ...feature, spentCents: 3 } : feature));
    expect(featureCapabilitiesSchema.safeParse({ ...body, features }).success).toBe(false);
  });

  it('refuses a mode it cannot act on, and a percentage out of range', () => {
    const body = fixture('capabilities.features.enforce');
    expect(featureCapabilitiesSchema.safeParse({ ...body, mode: 'maybe' }).success).toBe(false);
    const features = (body.features as Record<string, unknown>[]).map((feature, i) => (i === 0 ? { ...feature, usedPercent: 140 } : feature));
    expect(featureCapabilitiesSchema.safeParse({ ...body, features }).success).toBe(false);
  });

  it('turns a body that does not parse into a contract error, never a half-read list', async () => {
    serve({ success: true, mode: 'enforce', features: [{ id: 'assistant' }] });
    await expect(getFeatures()).rejects.toBeInstanceOf(ContractError);
  });
});
