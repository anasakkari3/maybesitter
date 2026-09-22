/**
 * "Some other time" — the custom postpone picker (UC-2.R3 #173, #337).
 *
 * ── Why this drives the screens ──────────────────────────────────
 *
 * `isPostponable` had unit tests and zero production callers: the sheet offered
 * four presets, each of which is `now` plus something, so the one rule the
 * function exists for — a user really can pick yesterday — was tested against a
 * branch nothing could reach. The same shape of hole `detailsEditFlow` was
 * written for.
 *
 * So this starts at the details screen, drives the real sheet and the real
 * `@react-native-community/datetimepicker`, and asserts on the `/api/mobile`
 * endpoint module — below the hook, at the boundary that builds the request.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import type { AuthUser } from '../../auth/types';
import { DetailsScreen } from '../DetailsScreen';
import { SheetHost } from '../Sheets';
import type { Commitment } from '../../api/schemas/common';
import ar from '../../i18n/locales/ar.json';
import en from '../../i18n/locales/en.json';
import he from '../../i18n/locales/he.json';

import * as commitmentEndpoints from '../../api/endpoints/commitments';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'postpone-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const ZONE = 'Asia/Jerusalem';
const ID = 'c-42';

/** Comfortably ahead of the clock this test runs on, whenever that is. */
const SOON = new Date(Date.now() + 5 * 24 * 3600_000);
const LONG_PAST = new Date('2020-01-02T09:00:00.000Z');

/**
 * The zone the app believes it is in, and the one thing this file changes per
 * test.
 *
 * A round trip through `localDateTimeFor` and `instantForLocalDateTime` returns
 * what it was given for *any* zone, so an assertion shaped like one proves
 * nothing about which zone was used — least of all here, where the host is
 * `Asia/Hebron` and the mocked zone was `Asia/Jerusalem`, the same offset.
 * `Pacific/Kiritimati` is +14 with no DST: no host runs there, and the
 * conversion is arithmetic this file can do itself.
 */
let mockZone = 'Asia/Jerusalem';
const FAR_ZONE = 'Pacific/Kiritimati';
const FAR_OFFSET_MS = 14 * 3600_000;

jest.mock('../../i18n/timezone', () => ({
  ...(jest.requireActual('../../i18n/timezone') as object),
  useTimeZone: () => mockZone,
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

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
});

afterEach(async () => {
  mockZone = 'Asia/Jerusalem';
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

async function show(data: Commitment = commitment()) {
  jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data, etag: 'W/"v1"' } as never);
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

async function openPostponeSheet(data: Commitment = commitment()) {
  await show(data);
  await fireEvent.press(screen.getByTestId('details-postpone'));
  await waitFor(() => expect(screen.queryByTestId('postpone-oneHour')).not.toBeNull());
}

async function openCustom(data: Commitment = commitment()) {
  await openPostponeSheet(data);
  await fireEvent.press(screen.getByTestId('postpone-custom'));
  await waitFor(() => expect(screen.queryByTestId('postpone-pick-time')).not.toBeNull());
}

/**
 * Opens the real picker and answers it.
 *
 * Not a stub: `@react-native-community/datetimepicker` is the component the app
 * ships, and its own `onChange` contract is what the sheet has to read
 * correctly. A fake here would pass whatever shape this file invented.
 */
async function pickTime(at: Date) {
  await fireEvent.press(screen.getByTestId('postpone-pick-time'));
  await waitFor(() => expect(screen.queryByTestId('postpone-picker')).not.toBeNull());
  await fireEvent(screen.getByTestId('postpone-picker'), 'change', {
    type: 'set',
    nativeEvent: { timestamp: at.getTime() },
  });
}

/** The flattened style of a rendered `Txt`. */
function styleOf(node: { props: Record<string, unknown> }): Record<string, unknown> {
  const style = node.props.style;
  return Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style as Record<string, unknown>);
}

describe('the custom option', () => {
  it('sits with the presets and opens a real picker', async () => {
    await openPostponeSheet();
    // The presets are untouched: the custom picker is a fifth answer, not a
    // replacement for the four that need no thought.
    for (const preset of ['oneHour', 'threeHours', 'tomorrowMorning', 'nextWeek']) {
      expect(screen.queryByTestId(`postpone-${preset}`)).not.toBeNull();
    }
    expect(screen.queryByTestId('postpone-custom')).not.toBeNull();
    expect(screen.queryByTestId('postpone-picker')).toBeNull();

    await fireEvent.press(screen.getByTestId('postpone-custom'));
    await waitFor(() => expect(screen.queryByTestId('postpone-pick-date')).not.toBeNull());
    expect(screen.queryByTestId('postpone-pick-time')).not.toBeNull();
    expect(screen.queryByTestId('postpone-custom-confirm')).not.toBeNull();

    // An hour from now is offered, not sent: the panel opens with a day and an
    // hour already filled in, and both pickers are reachable.
    expect(String(screen.getByTestId('postpone-custom-time').props.children)).not.toBe(en.editItemTime);
    await fireEvent.press(screen.getByTestId('postpone-pick-date'));
    await waitFor(() => expect(screen.queryByTestId('postpone-picker')).not.toBeNull());
  });

  it('sends nothing until the user confirms it', async () => {
    const act = jest.spyOn(commitmentEndpoints, 'actOnCommitment');
    await openCustom();
    await pickTime(new Date(SOON.getTime() + 3 * 3600_000));
    // Opening a picker and moving it is not an answer. The sheet is still open.
    expect(act).not.toHaveBeenCalled();
    expect(screen.queryByTestId('postpone-custom-confirm')).not.toBeNull();
  });
});

describe('a custom time the user picked', () => {
  it('is postponed to the exact instant, in the user’s zone and not the host’s', async () => {
    // +14, where nothing running this test can be.
    mockZone = FAR_ZONE;
    const act = jest.spyOn(commitmentEndpoints, 'actOnCommitment')
      .mockResolvedValue({ data: { success: true, id: ID, commitment: commitment() }, etag: 'W/"v2"' } as never);
    await openCustom();

    // A day comfortably ahead of whenever this runs, named the way Kiritimati
    // reads it, so this does not rot when the clock passes it (#382).
    const day = new Date(Date.now() + FAR_OFFSET_MS + 40 * 86_400_000).toISOString().slice(0, 10);
    const wall = `${day}T17:45`;
    // 17:45 on that day in a fixed +14 zone is this instant and no other. It is
    // computed here by subtracting the offset, never by asking the code under
    // test, so the assertion below is an absolute answer rather than a round
    // trip that any zone would satisfy.
    const expected = new Date(Date.parse(`${wall}:00.000Z`) - FAR_OFFSET_MS).toISOString();

    await pickTime(new Date(expected));
    // What the sheet reads back is the wall clock the user turned the wheel to.
    // Parse that string in the host's zone instead and this reads 05:45.
    expect(String(screen.getByTestId('postpone-custom-time').props.children)).toContain('17:45');

    await fireEvent.press(screen.getByTestId('postpone-custom-confirm'));
    await waitFor(() => expect(act).toHaveBeenCalled());

    expect(act.mock.calls[0]![1]).toBe('postpone');
    const sent = (act.mock.calls[0]![2] as { postponedUntil: string }).postponedUntil;
    expect(sent).toBe(expected);
    expect(screen.queryByTestId('postpone-problem')).toBeNull();
  });
});

describe('a custom time that has already gone', () => {
  it('is refused with a visible reason, and nothing is sent', async () => {
    const act = jest.spyOn(commitmentEndpoints, 'actOnCommitment');
    await openCustom();

    await pickTime(LONG_PAST);
    await fireEvent.press(screen.getByTestId('postpone-custom-confirm'));

    await waitFor(() => expect(screen.queryByTestId('postpone-problem')).not.toBeNull());
    // `postponeCommitment` answers a past `postponedUntil` with a 400 before
    // the state machine sees it; the client says the same thing first, in the
    // same words the edit sheet uses for the same rule.
    expect(screen.getByTestId('postpone-problem').props.children).toBe(en.editItemPast);
    expect(act).not.toHaveBeenCalled();
    // The sheet stays open so the user can answer the complaint.
    expect(screen.queryByTestId('postpone-pick-time')).not.toBeNull();
  });

  it('stops complaining once a future time is picked, and then sends it', async () => {
    const act = jest.spyOn(commitmentEndpoints, 'actOnCommitment')
      .mockResolvedValue({ data: { success: true, id: ID, commitment: commitment() }, etag: 'W/"v2"' } as never);
    await openCustom();
    await pickTime(LONG_PAST);
    await fireEvent.press(screen.getByTestId('postpone-custom-confirm'));
    await waitFor(() => expect(screen.queryByTestId('postpone-problem')).not.toBeNull());

    await pickTime(new Date(SOON.getTime() + 2 * 3600_000));
    expect(screen.queryByTestId('postpone-problem')).toBeNull();
    await fireEvent.press(screen.getByTestId('postpone-custom-confirm'));
    await waitFor(() => expect(act).toHaveBeenCalled());
  });
});

describe('right-to-left', () => {
  it('renders the Arabic copy right-to-left, with Latin digits in the hour', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await openPostponeSheet();
    await waitFor(() => expect(screen.queryByText(ar.postponeCustom)).not.toBeNull());

    await fireEvent.press(screen.getByTestId('postpone-custom'));
    await waitFor(() => expect(screen.queryByText(ar.postponeCustomWhen)).not.toBeNull());
    expect(screen.queryByText(ar.postponeCustomConfirm)).not.toBeNull();

    const label = screen.getByText(ar.postponeCustomWhen);
    expect(styleOf(label).writingDirection).toBe('rtl');
    // iOS Fabric swaps this logical edge under inherited RTL.
    expect(styleOf(label).textAlign).toBe('left');
    // Arabic is `ar-u-nu-latn` (src/i18n/README.md), so the clock reads 18:00
    // and not ١٨:٠٠ — and it is wrapped in U+2066/U+2069 so it does not
    // reverse inside the Arabic line.
    const time = String(screen.getByTestId('postpone-custom-time').props.children);
    expect(time).toMatch(/^⁦\d{2}:\d{2}⁩$/);
    // The digits are set in Outfit: Noto Naskh's line box clips them.
    expect(styleOf(screen.getByTestId('postpone-custom-time')).fontFamily).toMatch(/^Outfit_/);
    // The date beside them is Arabic copy in the Arabic face.
    expect(styleOf(screen.getByTestId('postpone-custom-date')).fontFamily).toMatch(/^NotoNaskhArabic_/);
  });

  it('hard-codes no physical side in the sheet', () => {
    // The eslint rule bans marginLeft/paddingRight and friends; this covers the
    // flex properties it does not, which mirror just as wrongly.
    const source = readFileSync(join(__dirname, '..', 'Sheets.tsx'), 'utf8');
    expect(source).not.toMatch(/flexDirection: 'row-reverse'/);
    expect(source).not.toMatch(/\b(marginLeft|marginRight|paddingLeft|paddingRight):/);
  });

  it('renders the Hebrew copy too', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'he');
    await openPostponeSheet();
    await waitFor(() => expect(screen.queryByText(he.postponeCustom)).not.toBeNull());

    await fireEvent.press(screen.getByTestId('postpone-custom'));
    await waitFor(() => expect(screen.queryByText(he.postponeCustomWhen)).not.toBeNull());
    // Hebrew is machine translated and says so (src/i18n/README.md); what is
    // asserted here is that the keys exist, render, and draw in the Hebrew face.
    expect(styleOf(screen.getByTestId('postpone-custom-date')).fontFamily).toMatch(/^NotoSansHebrew_/);
    expect(String(screen.getByTestId('postpone-custom-time').props.children)).toMatch(/^⁦\d{2}:\d{2}⁩$/);
  });
});
