import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { apiRequest } from '../client';
import { getCommitment, patchCommitment } from '../endpoints/commitments';
import { ConflictError, ContractError, InvalidTransitionError, StaleCommitmentError } from '../errors';
import { commitmentSchema } from '../schemas/common';
import { userFacingMessage } from '../ui/userFacingMessage';
import { strings, type Lang } from '../../i18n/strings';

/**
 * Two devices, one account (#148).
 *
 * A phone completes a commitment while a tablet holds the old copy. The
 * tablet's edit must be refused — and refused in a way that lets it show the
 * user what actually happened, rather than reporting a generic failure or,
 * worse, overwriting the phone's change.
 *
 * The server contract landed in #266. These assertions are against the
 * fixtures that test's routes produced, so they describe the real wire shapes.
 */

const FIXTURES = join(__dirname, '..', '__fixtures__');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

let requests: { headers: Record<string, string> }[] = [];

function serve(body: unknown, status: number, responseHeaders: Record<string, string> = {}): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: RequestInit) => {
    requests.push({ headers: (init.headers ?? {}) as Record<string, string> });
    return {
      status,
      text: async () => JSON.stringify(body),
      headers: { get: (name: string) => responseHeaders[name.toLowerCase()] ?? null },
    };
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

describe('the validator is echoed, never constructed', () => {
  it('comes back on a read and goes out unchanged on a write', async () => {
    // `updatedAt` plus a digest — a client cannot derive it, and must not try:
    // its shape is the server's to change.
    const etag = '"2026-08-09T09:00:00.000Z.1a2b3c4d5e6f"';
    serve(fixture('commitments.one'), 200, { etag });
    const read = await getCommitment('c1');
    expect(read.etag).toBe(etag);

    serve(fixture('commitments.patched'), 200);
    await patchCommitment('c1', { title: 'Call the dentist' }, read.etag ?? undefined);
    // The second request: `requests` spans both calls, and the first is the read.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers['If-Match']).toBe(etag);
  });

  it('sends nothing when there is no validator, so a first write is unconditional', async () => {
    serve(fixture('commitments.patched'), 200);
    await patchCommitment('c1', { title: 'x' });
    expect(requests[0]!.headers['If-Match']).toBeUndefined();
  });

  it('never derives a validator from updatedAt', async () => {
    // The obvious-looking shortcut, and the one the server's own comment warns
    // against: two changes in the same millisecond share an `updatedAt`.
    const commitment = commitmentSchema.parse(fixture('commitments.one'));
    serve(fixture('commitments.patched'), 200);
    await patchCommitment('c1', { title: 'x' });
    expect(requests[0]!.headers['If-Match']).toBeUndefined();
    expect(JSON.stringify(requests[0]!.headers)).not.toContain(commitment.updatedAt);
  });
});

describe('a stale edit', () => {
  it('becomes a StaleCommitmentError carrying the newer commitment', async () => {
    serve(fixture('commitments.stale'), 409);
    const error = await patchCommitment('c1', { title: 'x' }, '"old"').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StaleCommitmentError);
    // And still a ConflictError, so anything switching on 409 keeps working.
    expect(error).toBeInstanceOf(ConflictError);
    const stale = error as StaleCommitmentError;
    expect(stale.current.status).toBe('completed');
    expect(stale.current.id).toEqual(expect.any(String));
  });

  it('is not resubmitted — exactly one request is made', async () => {
    serve(fixture('commitments.stale'), 409);
    await patchCommitment('c1', { title: 'x' }, '"old"').catch(() => {});
    // Replaying an edit against a state the user has not seen is how one
    // device silently undoes another.
    expect(requests).toHaveLength(1);
  });

  it('is reported as a contract failure when `current` will not parse', async () => {
    // A screen cannot show what it cannot read, so this is not a conflict the
    // UI can act on — it is a backend the client no longer understands.
    serve({ success: false, reason: 'stale_commitment', current: { id: 'c1' } }, 409);
    const error = await patchCommitment('c1', { title: 'x' }, '"old"').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
  });
});

describe('an impossible move', () => {
  it('becomes an InvalidTransitionError, distinct from a stale edit', async () => {
    serve(fixture('commitments.invalidTransition'), 409);
    const error = await patchCommitment('c1', { title: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect(error).not.toBeInstanceOf(StaleCommitmentError);
  });

  it('still reads as a ConflictError for anything that only knows 409', async () => {
    serve(fixture('commitments.invalidTransition'), 409);
    const error = await patchCommitment('c1', { title: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
  });

  it('falls back to a plain ConflictError for a 409 with no reason', async () => {
    serve({ success: false, error: 'something else' }, 409);
    const error = await apiRequest('POST', '/api/mobile/x', { schema: commitmentSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).not.toBeInstanceOf(StaleCommitmentError);
    expect(error).not.toBeInstanceOf(InvalidTransitionError);
  });
});

describe('what the user is told', () => {
  it('says another device changed it, not that something went wrong', () => {
    const current = commitmentSchema.parse(fixture('commitments.one'));
    for (const lang of ['ar', 'en'] as Lang[]) {
      expect(userFacingMessage(new StaleCommitmentError(current), strings[lang])).toBe(
        strings[lang].errorsStaleCommitment,
      );
      expect(userFacingMessage(new InvalidTransitionError(), strings[lang])).toBe(
        strings[lang].errorsInvalidTransition,
      );
    }
  });

  it('does not fall through to the generic conflict copy', () => {
    const current = commitmentSchema.parse(fixture('commitments.one'));
    // A generic ConflictError has no copy of its own and lands on `generic`;
    // these two must not, or the user is told nothing useful.
    expect(userFacingMessage(new StaleCommitmentError(current), strings.en)).not.toBe(strings.en.errorsGeneric);
    expect(userFacingMessage(new InvalidTransitionError(), strings.en)).not.toBe(strings.en.errorsGeneric);
    expect(userFacingMessage(new ConflictError('x'), strings.en)).toBe(strings.en.errorsGeneric);
  });

  it('never leaks the commitment title it is holding', () => {
    const current = commitmentSchema.parse(fixture('commitments.one'));
    expect(current.title).not.toBe('');
    for (const lang of ['ar', 'en'] as Lang[]) {
      expect(userFacingMessage(new StaleCommitmentError(current), strings[lang])).not.toContain(current.title);
    }
  });
});
