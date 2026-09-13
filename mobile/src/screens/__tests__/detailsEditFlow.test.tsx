/**
 * Editing a commitment, from the screen a user reaches it on (UC-2.R3, #173).
 *
 * ── Why this drives the screens ──────────────────────────────────
 *
 * `buildTimePatch` had unit tests and zero production callers: the edit sheet
 * changed a title and an importance and nothing else, so every rule about which
 * time field a move sends was tested against a function nobody called. The same
 * shape of hole `captureFlowReachable.test.tsx` was written for.
 *
 * So this starts at the details screen, drives the real sheet, and asserts on
 * the `/api/mobile` endpoint module — below the hook, at the boundary that
 * builds the request. Mocking `usePatchCommitment` would let the wiring come
 * undone again and stay green.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { DetailsScreen } from '../DetailsScreen';
import { SheetHost } from '../Sheets';
import { usePatchCommitment } from '../../api/queries';
import { StaleCommitmentError } from '../../api/errors';
import type { Commitment } from '../../api/schemas/common';
import en from '../../i18n/locales/en.json';

import * as commitmentEndpoints from '../../api/endpoints/commitments';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'edit-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const ZONE = 'Asia/Jerusalem';
const ID = 'c-42';

/** An hour that is comfortably ahead of the clock this test runs on. */
const SOON = new Date(Date.now() + 3 * 24 * 3600_000);
const LONG_PAST = '2020-01-02T09:00:00.000Z';

jest.mock('../../i18n/timezone', () => ({
  ...(jest.requireActual('../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
const ORIGINAL_FLAG = process.env.EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH;

function commitment(extra: Partial<Commitment> = {}): Commitment {
  return {
    id: ID,
    kind: 'task',
    title: 'Hand in the project report',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: SOON.toISOString(), remindAt: null, timezone: ZONE },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...extra,
  } as Commitment;
}

/** Opens Details on `ID` the way a row tap does. The ref guard stops a loop. */
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

/**
 * A button that calls the mutation directly.
 *
 * The flag's promise is "no PATCH is ever sent", not "the button is greyed
 * out", so it is proved against a control that is fully enabled and a spy on
 * the endpoint — a disabled button proves only that one screen chose not to
 * offer it.
 */
function PatchHarness() {
  const patch = usePatchCommitment();
  return (
    <Pressable testID="harness-patch" onPress={() => patch.mutate({ id: ID, patch: { title: 'From the harness' } })}>
      <Text testID="harness-state">{patch.isError ? 'refused' : patch.isSuccess ? 'sent' : 'idle'}</Text>
    </Pressable>
  );
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  delete process.env.EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH;
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  if (ORIGINAL_FLAG === undefined) delete process.env.EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH;
  else process.env.EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH = ORIGINAL_FLAG;
  // The variable is spelled out rather than held in a constant: `expo lint`
  // refuses a dynamic read of process.env, and it is right to — a flag you
  // cannot grep for is a flag nobody finds when it misbehaves.
});

async function show(data: Commitment = commitment(), extra?: React.ReactNode) {
  jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data, etag: 'W/"v1"' } as never);
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <OpenDetails />
            <DetailsScreen />
            <SheetHost />
            {extra}
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
  return view;
}

async function openEditSheet(data: Commitment = commitment()) {
  await show(data);
  await fireEvent.press(screen.getByTestId('details-edit'));
  await waitFor(() => expect(screen.queryByTestId('edit-title')).not.toBeNull());
}

/**
 * Opens the real picker and answers it.
 *
 * Not a stub: `@react-native-community/datetimepicker` is the component the app
 * ships, and its own `onChange` contract is what the sheet has to read
 * correctly. A fake here would pass whatever shape this file invented.
 */
async function pickTime(at: Date) {
  await fireEvent.press(screen.getByTestId('edit-pick-time'));
  await waitFor(() => expect(screen.queryByTestId('edit-picker')).not.toBeNull());
  await fireEvent(screen.getByTestId('edit-picker'), 'change', {
    type: 'set',
    nativeEvent: { timestamp: at.getTime() },
  });
}

/** What the server will answer from now on. */
function serverNowHolds(data: Commitment, etag = 'W/"v2"') {
  jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data, etag } as never);
}

/** The body the client actually put on the wire. */
function sentPatch(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return spy.mock.calls[0]![1] as Record<string, unknown>;
}

describe('what the user changed reaches the account', () => {
  it('a new title is sent, and the screen then shows it', async () => {
    const changed = commitment({ title: 'Hand in the report', updatedAt: '2026-09-02T09:00:00.000Z' });
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: changed, etag: 'W/"v2"' } as never);
    await openEditSheet();
    serverNowHolds(changed);

    await fireEvent.changeText(screen.getByTestId('edit-title'), 'Hand in the report');
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(sentPatch(patch)).toEqual({ title: 'Hand in the report' });

    // The write is only half of it: the sheet closes and the item is refetched,
    // so what the screen shows is the server's answer, not the old render.
    await waitFor(() => expect(screen.queryByTestId('edit-title')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('details-title').props.children).toBe('Hand in the report'));
  });

  it('a new importance is sent alone, and the screen then shows it', async () => {
    const changed = commitment({
      priority: { level: 'low', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    } as Partial<Commitment>);
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: changed, etag: 'W/"v2"' } as never);
    await openEditSheet();
    serverNowHolds(changed);

    await fireEvent.press(screen.getByTestId('edit-priority-low'));
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    // The title did not change, so it is not resent: a PATCH that repeats an
    // unchanged field can overwrite another device's change to it.
    expect(sentPatch(patch)).toEqual({ priority: 'low' });

    // The sheet closes, so the only «Nice» left on screen is the badge the
    // details screen draws from the refetched commitment.
    await waitFor(() => expect(screen.queryByTestId('edit-priority-low')).toBeNull());
    await waitFor(() => expect(screen.queryByText(en.niceL)).not.toBeNull());
  });
});

describe('the time is editable, and buildTimePatch decides the fields', () => {
  it('a moved time sends dueDate alone, so the reminder lead survives', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    // Two hours of lead the user chose. Sending `reminderTime` as well would
    // collapse it onto the new due time — the defect buildTimePatch exists for.
    const withLead = commitment({
      timeSpec: {
        kind: 'due_by',
        dueAt: SOON.toISOString(),
        remindAt: new Date(SOON.getTime() - 2 * 3600_000).toISOString(),
        timezone: ZONE,
      },
    } as Partial<Commitment>);
    await openEditSheet(withLead);

    const moved = new Date(SOON.getTime() + 26 * 3600_000);
    await pickTime(moved);
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());

    const body = sentPatch(patch);
    expect(Object.keys(body)).toEqual(['dueDate']);
    expect(Date.parse(body.dueDate as string)).toBe(moved.getTime() - (moved.getTime() % 60_000));
  });

  it('an item that only ever had a reminder moves its reminder', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    const reminderOnly = commitment({
      timeSpec: { kind: 'due_by', dueAt: null, remindAt: SOON.toISOString(), timezone: ZONE },
    } as Partial<Commitment>);
    await openEditSheet(reminderOnly);

    await pickTime(new Date(SOON.getTime() + 3600_000));
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(Object.keys(sentPatch(patch))).toEqual(['reminderTime']);
  });

  it('removing the time sends both fields as null, which is not the same as silence', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    await openEditSheet();

    await fireEvent(screen.getByTestId('edit-no-time'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    // `dueDate: null` alone would leave the reminder standing, and an absent
    // field means "not edited" — neither is what the user just asked for.
    expect(sentPatch(patch)).toEqual({ dueDate: null, reminderTime: null });
  });

  it('an item that already has no time cannot ask for none again', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment');
    const undated = commitment({
      timeSpec: { kind: 'unscheduled', dueAt: null, remindAt: null, timezone: ZONE },
    } as Partial<Commitment>);
    await openEditSheet(undated);

    expect(screen.getByTestId('edit-no-time').props.value).toBe(true);
    expect(screen.getByTestId('edit-save').props.accessibilityState.disabled).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it('a title edit on a timed item still sends no time field at all', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    await openEditSheet();
    await fireEvent.changeText(screen.getByTestId('edit-title'), 'A typo fixed');
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(sentPatch(patch)).toEqual({ title: 'A typo fixed' });
  });
});

describe('a time that has already gone', () => {
  it('is refused while the sheet is open, and nothing is sent', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment');
    await openEditSheet();

    await pickTime(new Date(LONG_PAST));
    await fireEvent.press(screen.getByTestId('edit-save'));

    await waitFor(() => expect(screen.queryByTestId('edit-problem')).not.toBeNull());
    expect(screen.getByTestId('edit-problem').props.children).toBe(en.editItemPast);
    // The same words and the same moment as the capture edit sheet, and the
    // sheet stays open so the user can answer it.
    expect(patch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('edit-title')).not.toBeNull();
  });

  it('is not held against an item whose hour simply passed', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    const gone = commitment({
      timeSpec: { kind: 'due_by', dueAt: LONG_PAST, remindAt: null, timezone: ZONE },
    } as Partial<Commitment>);
    await openEditSheet(gone);

    await fireEvent.changeText(screen.getByTestId('edit-title'), 'Hand it in today instead');
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    // There is no "overdue" in this product: a passed hour is an ordinary
    // active item, and refusing to save it would mean a typo in yesterday's
    // title could never be fixed. The time is untouched, so none is sent.
    expect(sentPatch(patch)).toEqual({ title: 'Hand it in today instead' });
    expect(screen.queryByTestId('edit-problem')).toBeNull();
  });

  it('stops complaining once a future time is picked, and then saves', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    await openEditSheet();
    await pickTime(new Date(LONG_PAST));
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(screen.queryByTestId('edit-problem')).not.toBeNull());

    await pickTime(new Date(SOON.getTime() + 7200_000));
    expect(screen.queryByTestId('edit-problem')).toBeNull();
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
  });
});

describe('features.safeCommitmentPatch', () => {
  it('off: the details screen offers no edit at all', async () => {
    process.env.EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH = 'false';
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment');
    await show();
    // The other three actions are untouched: the flag is about the write this
    // screen makes, not about the screen.
    expect(screen.queryByTestId('details-edit')).toBeNull();
    expect(screen.queryByTestId('details-done')).not.toBeNull();
    expect(screen.queryByTestId('details-drop')).not.toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });

  it('off: the mutation itself sends nothing, from a control that is fully enabled', async () => {
    process.env.EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH = 'false';
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment');
    await show(commitment(), <PatchHarness />);

    await fireEvent.press(screen.getByTestId('harness-patch'));
    await waitFor(() => expect(screen.getByTestId('harness-state').props.children).toBe('refused'));
    expect(patch).not.toHaveBeenCalled();
  });

  it('on by default, and an unset or misspelt value leaves it on', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    process.env.EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH = 'FALSE';
    await show(commitment(), <PatchHarness />);
    expect(screen.queryByTestId('details-edit')).not.toBeNull();

    await fireEvent.press(screen.getByTestId('harness-patch'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
  });
});

describe('the conflict story is unchanged', () => {
  it('a 409 from another device is adopted rather than retried', async () => {
    const theirs = commitment({ title: 'Hand it in on Sunday', updatedAt: '2026-09-05T09:00:00.000Z' });
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockRejectedValue(new StaleCommitmentError(theirs) as never);
    await openEditSheet();
    serverNowHolds(theirs, 'W/"v9"');

    await fireEvent.changeText(screen.getByTestId('edit-title'), 'Hand it in on Monday');
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    // What the other device did is shown, and the edit is not replayed against
    // a state the user has not seen.
    await waitFor(() => expect(screen.getByTestId('details-title').props.children).toBe('Hand it in on Sunday'));
    expect(patch).toHaveBeenCalledTimes(1);
  });
});
