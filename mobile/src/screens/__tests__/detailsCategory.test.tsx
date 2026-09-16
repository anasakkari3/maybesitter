/**
 * The category, where the user can see it and change it (#415).
 *
 * The feature's own premise is that the app reads a category "with the user's
 * awareness". A field the extraction fills in that the user can never see is
 * not awareness — it is the app sorting somebody's life behind their back.
 * Details is where a commitment is looked at, so this is where the category is
 * shown and where it is corrected.
 *
 * The row is present even when there is no category, and says so. An absent
 * row would mean the only commitments a user could file are the ones the model
 * already filed — exactly backwards, since the ones it could not read are the
 * ones most worth correcting.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { DetailsScreen } from '../DetailsScreen';
import { SheetHost } from '../Sheets';
import type { Commitment } from '../../api/schemas/common';
import en from '../../i18n/locales/en.json';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as categoryEndpoints from '../../api/endpoints/categories';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'det-cat-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const ZONE = 'Asia/Jerusalem';
const ID = 'c-99';

jest.mock('../../i18n/timezone', () => ({
  ...(jest.requireActual('../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function commitment(category: Commitment['category']): Commitment {
  return {
    id: ID,
    kind: 'task',
    title: 'Hand in the project report',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    category,
    categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: '2026-09-13T15:00:00.000Z', remindAt: null, timezone: ZONE },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  } as Commitment;
}

function OpenDetails() {
  const { actions } = useApp();
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    actions.openDetail(ID);
  }, [actions]);
  return null;
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(categoryEndpoints, 'getCategoryPreferences').mockResolvedValue({
    success: true,
    categoryPreferences: { enabled: ['work', 'family'], grouping: false },
  } as never);
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show(category: Commitment['category']) {
  jest.spyOn(commitmentEndpoints, 'getCommitment')
    .mockResolvedValue({ data: commitment(category), etag: 'W/"v1"' } as never);

  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <OpenDetails />
            <DetailsScreen />
            <SheetHost />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
  return view;
}

describe('the category on Details', () => {
  it('names the category the app filed this under', async () => {
    await show('work');
    await waitFor(() => expect(screen.getByTestId('details-category')).toBeTruthy());
    expect(screen.getByTestId('details-category').props.children).toBe(en.catWork);
  });

  it('says so when there is none, rather than hiding the row', async () => {
    await show(null);
    await waitFor(() => expect(screen.getByTestId('details-category')).toBeTruthy());
    expect(screen.getByTestId('details-category').props.children).toBe(en.catNone);
  });

  it('lets the user file it somewhere else', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment('family'), etag: 'W/"v2"' } as never);
    await show('work');

    await waitFor(() => expect(screen.getByTestId('details-category-edit')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('details-category-edit'));

    await waitFor(() => expect(screen.getByTestId('category-pick-family')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('category-pick-family'));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(ID, { category: 'family' }, expect.anything()),
    );
  });

  it('offers only the categories this account uses, and a way to clear it', async () => {
    jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment(null), etag: 'W/"v2"' } as never);
    await show('work');

    await waitFor(() => expect(screen.getByTestId('details-category-edit')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('details-category-edit'));

    await waitFor(() => expect(screen.getByTestId('category-pick-work')).toBeTruthy());
    expect(screen.getByTestId('category-pick-family')).toBeTruthy();
    expect(screen.queryByTestId('category-pick-health')).toBeNull();
    expect(screen.getByTestId('category-pick-none')).toBeTruthy();
  });

  it('shows the category but offers no way to change it when patching is off', async () => {
    // The screen's own rule: hide a button you cannot honour. The label still
    // shows, because reading where something was filed costs nothing.
    process.env.EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH = 'false';
    try {
      await show('work');
      await waitFor(() => expect(screen.getByTestId('details-category')).toBeTruthy());
      expect(screen.getByTestId('details-category').props.children).toBe(en.catWork);
      expect(screen.queryByTestId('details-category-edit')).toBeNull();
      expect(screen.queryByTestId('category-pick-work')).toBeNull();
    } finally {
      delete process.env.EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH;
    }
  });

  it('clearing the category sends null rather than omitting the field', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment(null), etag: 'W/"v2"' } as never);
    await show('work');

    await waitFor(() => expect(screen.getByTestId('details-category-edit')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('details-category-edit'));
    await waitFor(() => expect(screen.getByTestId('category-pick-none')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('category-pick-none'));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(ID, { category: null }, expect.anything()),
    );
  });
});
