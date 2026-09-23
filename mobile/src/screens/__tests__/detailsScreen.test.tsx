/**
 * One commitment, and the four things that can be done to it (UC-2.R3 #173).
 *
 * The claims worth testing here are about what is *sent*: a tap on "Done" must
 * become `complete`, a preset must become the instant it displayed, and drop
 * and delete must not be the same request — one keeps the commitment in the
 * user's history and the other does not.
 */
import React from 'react';
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
import { NotFoundError } from '../../api/errors';
import type { Commitment } from '../../api/schemas/common';
import { postponeTo } from '../../features/commitments/postpone';
import en from '../../i18n/locales/en.json';

import * as commitmentEndpoints from '../../api/endpoints/commitments';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'det-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const ZONE = 'Asia/Jerusalem';
const ID = 'c-42';

jest.mock('../../i18n/timezone', () => ({
  ...(jest.requireActual('../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function commitment(extra: Partial<Commitment> = {}): Commitment {
  return {
    id: ID,
    kind: 'task',
    title: 'Hand in the project report',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-09-13T15:00:00.000Z', remindAt: null, timezone: ZONE },
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

/**
 * Opens Details on `ID` the way a row tap does.
 *
 * The guard is load-bearing: `actions` is rebuilt every render, so an effect
 * that depends on it and sets state re-fires forever. Without it this crashes
 * the V8 heap rather than failing.
 */
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
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show(data: Commitment | Error = commitment()) {
  const get = jest.spyOn(commitmentEndpoints, 'getCommitment');
  if (data instanceof Error) get.mockRejectedValue(data);
  else get.mockResolvedValue({ data, etag: 'W/"v1"' } as never);

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

describe('what it shows', () => {
  it('renders the commitment the account holds', async () => {
    await show();
    expect(screen.getByTestId('details-title').props.children).toBe('Hand in the project report');
    expect(screen.getByTestId('details-status').props.children).toBe(en.active);
    // Isolated with U+2066/U+2069, which is what stops "18:00" reversing
    // inside an Arabic line.
    expect(screen.getByTestId('details-time').props.children).toBe('\u2066'+'18:00'+'\u2069');
  });

  it('says a deleted commitment is gone, rather than showing an error', async () => {
    await show(new NotFoundError('gone'));
    expect(screen.queryByTestId('details-gone')).not.toBeNull();
    expect(screen.queryByTestId('details-done')).toBeNull();
  });

  it('offers no actions on something already finished', async () => {
    await show(commitment({ status: 'completed', completedAt: '2026-09-13T16:00:00.000Z' }));
    expect(screen.getByTestId('details-status').props.children).toBe(en.doneS);
    // Absent, not disabled (Round 2): a control that cannot succeed is worse
    // than an absent one, and there is no reopen route to offer instead.
    expect(screen.queryByTestId('details-done')).toBeNull();
    expect(screen.queryByTestId('details-drop')).toBeNull();
    expect(screen.queryByTestId('details-postpone')).toBeNull();
    expect(screen.getByTestId('details-closed-note')).toBeTruthy();
    // Delete stays: a finished item can still be removed from the lists.
    expect(screen.getByTestId('details-delete').props.accessibilityState.disabled).toBeFalsy();
  });
});

describe('done', () => {
  it('sends complete, and nothing else', async () => {
    const act = jest.spyOn(commitmentEndpoints, 'actOnCommitment')
      .mockResolvedValue({ data: { success: true, id: ID, commitment: commitment({ status: 'completed' }) }, etag: 'W/"v2"' } as never);
    await show();
    await fireEvent.press(screen.getByTestId('details-done'));
    await waitFor(() => expect(act).toHaveBeenCalled());
    expect(act.mock.calls[0]![1]).toBe('complete');
    expect(act.mock.calls[0]![2]).not.toHaveProperty('postponedUntil');
  });
});

describe('not now', () => {
  it('offers the four presets, each showing when it lands', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('details-postpone'));
    await waitFor(() => expect(screen.queryByTestId('postpone-oneHour')).not.toBeNull());
    for (const preset of ['oneHour', 'threeHours', 'tomorrowMorning', 'nextWeek']) {
      expect(screen.queryByTestId(`postpone-${preset}`)).not.toBeNull();
      // The promise is shown, not just named: "next week" alone is not a time.
      expect(String(screen.getByTestId(`postpone-when-${preset}`).props.children)).not.toBe('');
    }
  });

  it('sends the instant the preset resolves to in the user’s zone', async () => {
    const act = jest.spyOn(commitmentEndpoints, 'actOnCommitment')
      .mockResolvedValue({ data: { success: true, id: ID, commitment: commitment() }, etag: 'W/"v2"' } as never);
    await show();
    await fireEvent.press(screen.getByTestId('details-postpone'));
    await waitFor(() => expect(screen.queryByTestId('postpone-tomorrowMorning')).not.toBeNull());
    const before = new Date();
    await fireEvent.press(screen.getByTestId('postpone-tomorrowMorning'));
    await waitFor(() => expect(act).toHaveBeenCalled());

    expect(act.mock.calls[0]![1]).toBe('postpone');
    const sent = (act.mock.calls[0]![2] as { postponedUntil: string }).postponedUntil;
    // 09:00 tomorrow in Jerusalem, not "now + 24h": on the two days a year the
    // clocks move those differ by an hour.
    expect(sent).toBe(postponeTo('tomorrowMorning', before, ZONE));
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(sent)))
      .toBe('09:00');
  });
});

describe('drop and delete are not the same thing', () => {
  it('asks before dropping, and sends cancel', async () => {
    const act = jest.spyOn(commitmentEndpoints, 'actOnCommitment')
      .mockResolvedValue({ data: { success: true, id: ID, commitment: commitment({ status: 'dropped' }) }, etag: 'W/"v2"' } as never);
    await show();
    await fireEvent.press(screen.getByTestId('details-drop'));
    await waitFor(() => expect(screen.queryByText(en.confirmDropTitle)).not.toBeNull());
    expect(act).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('confirm-drop'));
    await waitFor(() => expect(act).toHaveBeenCalled());
    expect(act.mock.calls[0]![1]).toBe('cancel');
  });

  it('asks before deleting, and says what is different about it', async () => {
    const remove = jest.spyOn(commitmentEndpoints, 'deleteCommitment')
      .mockResolvedValue({ deleted: false, softDeleted: true, id: ID } as never);
    await show();
    await fireEvent.press(screen.getByTestId('details-delete'));
    await waitFor(() => expect(screen.queryByText(en.confirmDeleteTitle)).not.toBeNull());
    // The copy must say the thing the two buttons differ on.
    expect(screen.queryByText(en.confirmDeleteBody)).not.toBeNull();
    expect(remove).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('confirm-delete'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(ID, 'W/"v1"'));
  });

  it('does nothing at all when the confirm is declined', async () => {
    const act = jest.spyOn(commitmentEndpoints, 'actOnCommitment');
    const remove = jest.spyOn(commitmentEndpoints, 'deleteCommitment');
    await show();
    await fireEvent.press(screen.getByTestId('details-delete'));
    await waitFor(() => expect(screen.queryByTestId('confirm-keep')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('confirm-keep'));
    await waitFor(() => expect(screen.queryByTestId('confirm-delete')).toBeNull());
    expect(act).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('editing', () => {
  it('sends only what changed', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment({ title: 'Hand in the report' }), etag: 'W/"v2"' } as never);
    await show();
    await fireEvent.press(screen.getByTestId('details-edit'));
    await waitFor(() => expect(screen.queryByTestId('edit-title')).not.toBeNull());

    await fireEvent.changeText(screen.getByTestId('edit-title'), 'Hand in the report');
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    // The priority did not change, so it is not sent: a PATCH that resends an
    // unchanged field can overwrite another device's change to it.
    expect(patch.mock.calls[0]![1]).toEqual({ title: 'Hand in the report' });
  });

  it('sends the priority alone when only the priority changed', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment')
      .mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    await show();
    await fireEvent.press(screen.getByTestId('details-edit'));
    await waitFor(() => expect(screen.queryByTestId('edit-priority-low')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('edit-priority-low'));
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]![1]).toEqual({ priority: 'low' });
  });

  it('cannot save nothing', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('details-edit'));
    await waitFor(() => expect(screen.queryByTestId('edit-save')).not.toBeNull());
    expect(screen.getByTestId('edit-save').props.accessibilityState.disabled).toBe(true);
  });

  it('cannot save an empty title', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('details-edit'));
    await waitFor(() => expect(screen.queryByTestId('edit-title')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('edit-title'), '   ');
    expect(screen.getByTestId('edit-save').props.accessibilityState.disabled).toBe(true);
  });
});

describe('what is deliberately absent', () => {
  it('offers no reopen, because the route does not accept one', async () => {
    // `actions` takes complete | postpone | cancel. A reopen button would be a
    // control that always fails; #173 records the backend follow-up instead.
    await show(commitment({ status: 'completed' }));
    expect(screen.queryByText('Reopen')).toBeNull();
    expect(screen.queryByText('Mark pending')).toBeNull();
  });

  it('offers no duration or scope edits', async () => {
    // The prototype's Rearrange sheet had "Intensify — same content, shorter
    // time" and "Do less of it". Neither is a thing the domain can express.
    await show();
    await fireEvent.press(screen.getByTestId('details-postpone'));
    await waitFor(() => expect(screen.queryByTestId('postpone-oneHour')).not.toBeNull());
    expect(screen.queryByText(en.intensify)).toBeNull();
    expect(screen.queryByText(en.shrink)).toBeNull();
  });
});
