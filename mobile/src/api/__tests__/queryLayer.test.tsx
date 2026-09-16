import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Text } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../auth/fakeAuthRepository';
import { setAuthRepository, resetAuthForTests } from '../auth';
import { createAppQueryClient, MAX_QUERY_RETRIES, STALE_TIME_MS } from '../queryClient';
import { forgetValidators, queryKeys, rememberValidator, useToday, validatorFor } from '../queries';
import { ApiProvider } from '../ui/ApiProvider';
import { QueryBoundary } from '../ui/QueryBoundary';
import { ForbiddenError, isRetryable, NetworkError, ValidationError } from '../errors';
import type { AuthUser } from '../../auth/types';
import en from '../../i18n/locales/en.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const FIXTURES = join(__dirname, '..', '__fixtures__');
// The today fixture is legitimately empty — the exporter completes then drops
// its one commitment — so the populated list comes from `upcoming`, which is
// the same `{ items: Commitment[] }` shape. What matters here is that a row
// was cached and then was not.
const listWithRows = JSON.parse(readFileSync(join(FIXTURES, 'commitments.upcoming.json'), 'utf8')) as { items: unknown[] };

function userWith(uid: string): AuthUser {
  return { uid, email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
}

let repository: FakeAuthRepository;
/**
 * One client per case, cleared afterwards. React Query keeps a five-minute
 * garbage-collection timer per query, and Jest waits for the event loop to
 * drain — so a client left behind holds the whole run open for five minutes.
 */
let client: ReturnType<typeof createAppQueryClient>;

beforeEach(() => {
  client = createAppQueryClient();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  repository = createFakeAuthRepository({ initialUser: userWith('alice') });
  setAuthRepository(repository);
  onlineManager.setOnline(true);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('query defaults', () => {
  it('retries only what a retry can fix, and never a mutation', () => {
    const client = createAppQueryClient();
    const queries = client.getDefaultOptions().queries;
    const retry = queries?.retry as (count: number, error: unknown) => boolean;

    expect(queries?.staleTime).toBe(STALE_TIME_MS);
    expect(retry(0, new NetworkError('x'))).toBe(true);
    expect(retry(MAX_QUERY_RETRIES, new NetworkError('x'))).toBe(false);
    // A 400 will be a 400 again. Retrying it only delays the message.
    expect(retry(0, new ValidationError('x'))).toBe(false);
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
  });

  it('refetches when the app is focused again and when the signal returns', () => {
    const queries = createAppQueryClient().getDefaultOptions().queries;
    expect(queries?.refetchOnReconnect).toBe(true);
    expect(queries?.refetchOnWindowFocus).toBe(true);
  });

  it('keeps query keys scoped to a uid, so two accounts cannot collide', () => {
    expect(queryKeys.today('alice', 'UTC')).not.toEqual(queryKeys.today('blake', 'UTC'));
    expect(queryKeys.today('alice', 'UTC')[1]).toBe('alice');
    // Activity is a record of what a person did, so an unscoped key here would
    // be the #148 leak in its most literal form (#201).
    expect(queryKeys.activity('alice')).not.toEqual(queryKeys.activity('blake'));
    expect(queryKeys.activity('alice')[1]).toBe('alice');
    expect(queryKeys.activitySummary('alice', 'current')[1]).toBe('alice');
    expect(queryKeys.activitySummary('alice', '2026-09-13'))
      .not.toEqual(queryKeys.activitySummary('alice', '2026-09-20'));
  });

  /**
   * The same rule, asserted over the whole table rather than key by key.
   *
   * The list above names the keys somebody thought to name, which is exactly
   * how `plan` and `planSettings` arrived (#195) uncovered: a new hook adds a
   * key and nothing asks whether it carries a uid. Every builder here takes the
   * uid first and every key this app has is `['user', uid, …]`, so the rule can
   * be checked without being restated — and the count is pinned so a key that
   * stops being enumerable is a failure rather than a vacuous pass.
   */
  it('scopes every key in the table, including ones added later', () => {
    const builders = Object.entries(queryKeys);
    expect(builders.length).toBeGreaterThanOrEqual(10);
    for (const [name, build] of builders) {
      const mine = (build as (...args: string[]) => readonly unknown[])('alice', '2026-08-09', '2026-08-09');
      const theirs = (build as (...args: string[]) => readonly unknown[])('blake', '2026-08-09', '2026-08-09');
      expect({ name, scope: mine[0], uid: mine[1] }).toEqual({ name, scope: 'user', uid: 'alice' });
      expect({ name, collides: JSON.stringify(mine) === JSON.stringify(theirs) }).toEqual({ name, collides: false });
    }
  });

  it('agrees with isRetryable', () => {
    expect(isRetryable(new NetworkError('x'))).toBe(true);
    expect(isRetryable(new ValidationError('x'))).toBe(false);
  });
});

describe('switching accounts on one device', () => {
  /** Renders whatever Today currently holds, straight from the cache. */
  function TodayProbe() {
    const { data } = useToday();
    return <Text testID="today">{data ? `rows:${data.items.length}` : 'none'}</Text>;
  }

  async function renderApp() {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify(listWithRows),
    })) as never;

    return render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <ApiProvider client={client}>
              <TodayProbe />
            </ApiProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
  }

  it('shows nothing from the previous account after a uid change', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('today')).toHaveTextContent(`rows:${listWithRows.items.length}`));

    // Alice signs out, Blake signs in. Nothing Alice loaded may survive that,
    // not even for the frame before Blake's own fetch lands.
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => new Promise(() => {})) as never;
    await act(async () => {
      repository.emit(userWith('blake'));
    });

    expect(screen.getByTestId('today')).toHaveTextContent('none');
  });

  it('holds nothing in memory once the user signs out', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('today')).toHaveTextContent(`rows:${listWithRows.items.length}`));

    await act(async () => {
      repository.emit(null);
    });
    expect(screen.getByTestId('today')).toHaveTextContent('none');
  });
});

describe('the validator store (#148)', () => {
  afterEach(() => forgetValidators());

  it('remembers a validator per commitment and forgets a null one', () => {
    rememberValidator('c1', '"2026-08-09T09:00:00.000Z.abc123"');
    rememberValidator('c2', null);
    expect(validatorFor('c1')).toBe('"2026-08-09T09:00:00.000Z.abc123"');
    // A response with no ETag must not overwrite a good validator with
    // undefined, nor invent one.
    expect(validatorFor('c2')).toBeUndefined();
  });

  it('is cleared outright, so one account cannot reach another', () => {
    rememberValidator('c1', '"x"');
    forgetValidators();
    expect(validatorFor('c1')).toBeUndefined();
  });
});

describe('QueryBoundary', () => {
  async function renderBoundary(props: { isPending: boolean; error: unknown }) {
    return render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <QueryClientProvider client={client}>
            <QueryBoundary {...props} onRetry={() => {}}>
              <Text>THE DATA</Text>
            </QueryBoundary>
          </QueryClientProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
  }

  it('shows the data when there is data', async () => {
    await renderBoundary({ isPending: false, error: null });
    expect(screen.getByText('THE DATA')).toBeTruthy();
  });

  it('shows a spinner while loading', async () => {
    await renderBoundary({ isPending: true, error: null });
    expect(screen.getByTestId('query-loading')).toBeTruthy();
    expect(screen.queryByText('THE DATA')).toBeNull();
  });

  it('offers Retry for a failure a retry could fix', async () => {
    await renderBoundary({ isPending: false, error: new NetworkError('fetch failed') });
    expect(screen.getByText(en.errorsNetwork)).toBeTruthy();
    expect(screen.getByLabelText(en.errorsRetry)).toBeTruthy();
  });

  it('renders a revoked account as its own state, with no Retry', async () => {
    await renderBoundary({ isPending: false, error: new ForbiddenError('no', 'revoked') });
    expect(screen.getByText(en.authSignedOutRevoked)).toBeTruthy();
    // Retrying cannot un-revoke an account; offering it would be a lie.
    expect(screen.queryByLabelText(en.errorsRetry)).toBeNull();
  });

  it('renders quiet mode as the user’s own choice, not an error', async () => {
    await renderBoundary({ isPending: false, error: new ForbiddenError('no', 'quiet_mode') });
    expect(screen.getByText(en.errorsQuietMode)).toBeTruthy();
    expect(screen.queryByLabelText(en.errorsRetry)).toBeNull();
  });
});
