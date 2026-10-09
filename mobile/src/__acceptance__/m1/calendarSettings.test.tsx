/**
 * M1 · Task B · criteria 2 and 5 (calendar half) — Settings → Calendar
 * (owner audit image 14; conditions 50–51).
 *
 * Acceptance gate written before the build (PLAN-B.md). Asserts only what a
 * person sees: the old Arabic of the yellow block (hard-coded from `ar.json`
 * at 62699810, since the keys may go), whether a busy count is on screen at
 * all, the Disclosure contract (`*-why` → `*-why-body`), and the display name
 * the plan fixes for Android's resource-id calendars («تقويم التلفون»).
 *
 * A busy count is detected by its digits, never by its wording: the builder
 * chooses the new sentence, but any rendering of "7 busy times" carries a 7.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { CalendarSettingsScreen } from '../../features/settings/CalendarSettingsScreen';
import * as calendarEndpoints from '../../api/endpoints/calendar';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as trustEndpoints from '../../api/endpoints/trust';
import { deviceCalendar, type DeviceEventCalendar, type WritableCalendar } from '../../features/calendar/deviceCalendar';
import { resetWriterIdCache } from '../../lib/deviceSettings/calendarDevice';
import { BUSY_BLOCKS_KEY, LEGACY_BUSY_KEYS } from '../../lib/deviceSettings/calendarBusy';
import { seedDeviceBusyCache } from '../../testing/deviceBusyCache';
import { resetCalendarSyncForTests } from '../../features/calendar/useDeviceCalendarSync';
import { resetBusySyncForTests } from '../../features/calendar/useBusyCalendar';

/** The exact Arabic at 62699810 — the yellow block that must be rewritten. */
const OLD = {
  /** `calendarBusyCount`, a `fill()` template that cannot inflect. */
  busyCountTail: '\u0648\u0642\u062a \u0645\u0634\u063a\u0648\u0644 \u0645\u0646 \u0647\u0627\u062f \u0627\u0644\u062a\u0644\u0641\u0648\u0646',  // «وقت مشغول من هاد التلفون»
  declinedNote: '\u0627\u0644\u0627\u062c\u062a\u0645\u0627\u0639 \u0627\u0644\u0644\u064a \u0631\u0641\u0636\u062a\u0647 \u0628\u064a\u0636\u0644\u0651 \u0645\u062d\u0633\u0648\u0628 \u0645\u0634\u063a\u0648\u0644.',  // «الاجتماع اللي رفضته بيضلّ محسوب مشغول.»
  disconnectBody: '\u0628\u064a\u0648\u0642\u0651\u0641 \u0642\u0631\u0627\u0621\u0629 \u0627\u0644\u062a\u0642\u0648\u064a\u0645 \u0648\u0628\u064a\u0645\u0633\u062d \u0627\u0644\u0623\u0648\u0642\u0627\u062a \u0627\u0644\u0645\u0634\u063a\u0648\u0644\u0629 \u0645\u0646 \u0647\u0627\u062f \u0627\u0644\u062a\u0644\u0641\u0648\u0646 \u0648\u0645\u0646 \u062d\u0633\u0627\u0628\u0643.',  // «بيوقّف قراءة التقويم وبيمسح الأوقات المشغولة من هاد التلفون ومن حسابك.»
} as const;
/** The display name the plan fixes for an Android resource-id calendar name. */
const PHONE_CALENDAR = '\u062a\u0642\u0648\u064a\u0645 \u0627\u0644\u062a\u0644\u0641\u0648\u0646';  // «تقويم التلفون»
/** `calendarBusyCount` filled with `n`. */
const oldBusyCount = (n: number) => `${n} ${OLD.busyCountTail}`;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'm1-calendar-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const CALENDARS: DeviceEventCalendar[] = [
  { id: 'g-work', title: 'Work', color: null, sourceName: 'anas@gmail.com' },
];

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let consent = true;
const originalOs = Platform.OS;

function trustWith(calendarConsent: boolean) {
  return { success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent } };
}

/** `n` distinct busy blocks over the coming days, as the device read returns them. */
function blocks(n: number) {
  const start = Date.now() + 2 * 3600_000;
  return Array.from({ length: n }, (_, i) => ({
    nativeId: `evt-${i}`,
    startAt: new Date(start + i * 3 * 3600_000).toISOString(),
    endAt: new Date(start + i * 3 * 3600_000 + 3600_000).toISOString(),
    allDay: false,
  }));
}

/** A cached read from an earlier session: what must never be presented as current. */
async function seedCache(n: number) {
  // The signed-in account's own cache (M4a, M4A-R8-001).
  await seedDeviceBusyCache(USER.uid, blocks(n), { syncedAt: Date.now() });
}

beforeEach(async () => {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ;
  onlineManager.setOnline(true);
  resetWriterIdCache();
  resetCalendarSyncForTests();
  resetBusySyncForTests();
  await AsyncStorage.multiRemove(['calendar.excludedCalendarIds.v1', BUSY_BLOCKS_KEY, ...LEGACY_BUSY_KEYS]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(calendarEndpoints, 'getCalendarSettings')
    .mockResolvedValue({ success: true, calendarSettings: { writeTarget: 'off', updatedAt: null } } as never);
  jest.spyOn(calendarEndpoints, 'postCalendarBusy').mockResolvedValue({
    success: true, blocks: 0,
    source: { sourceId: 'device:x', lastSyncedAt: new Date().toISOString(), windowStart: null, windowEnd: null },
  } as never);
  jest.spyOn(calendarEndpoints, 'deleteCalendarBusy').mockResolvedValue({ success: true, deleted: 0 } as never);
  consent = true;
  jest.spyOn(trustEndpoints, 'getTrust').mockImplementation((async () => trustWith(consent)) as never);
  jest.spyOn(trustEndpoints, 'updateTrust').mockImplementation((async (action: { granted: boolean }) => {
    consent = action.granted;
    return trustWith(consent);
  }) as never);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  jest.spyOn(deviceCalendar, 'listEventCalendars').mockResolvedValue(CALENDARS);
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([]);
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ;
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE;
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <CalendarSettingsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  // Arabic is on screen…
  await waitFor(() => expect(screen.queryAllByText('\u0627\u0644\u062a\u0642\u0648\u064a\u0645').length).toBeGreaterThan(0));  // «التقويم»
  // …the server's consent and the phone's answer have both been read…
  await waitFor(() => expect(trustEndpoints.getTrust).toHaveBeenCalled());
  await waitFor(() => expect(deviceCalendar.getAccess).toHaveBeenCalled());
  // …and whatever the mount kicks off (busy sync, cache read) has settled.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}

/** Mounted while reading is on: waits for the phone's calendars to be listed. */
async function showReading() {
  await show();
  await waitFor(() => expect(screen.queryByTestId('calendar-device-g-work') ?? screen.queryAllByText(PHONE_CALENDAR)[0] ?? null).not.toBeNull());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };

function jsonText(node: Json | string): string {
  return typeof node === 'string' ? node : (node.children ?? []).map(jsonText).join('');
}

/** The text of every Text on screen, one entry per Text. */
function screenTexts(): string[] {
  const out: string[] = [];
  const walk = (node: Json | string | null) => {
    if (!node || typeof node === 'string') return;
    if (node.type === 'Text') out.push(jsonText(node));
    for (const child of node.children ?? []) walk(child);
  };
  const root = screen.toJSON() as unknown as Json | Json[] | null;
  for (const node of Array.isArray(root) ? root : [root]) walk(node);
  return out;
}

/** Every accessibilityLabel on screen. */
function screenLabels(): string[] {
  const out: string[] = [];
  const walk = (node: Json | string | null) => {
    if (!node || typeof node === 'string') return;
    if (typeof node.props.accessibilityLabel === 'string') out.push(node.props.accessibilityLabel);
    for (const child of node.children ?? []) walk(child);
  };
  const root = screen.toJSON() as unknown as Json | Json[] | null;
  for (const node of Array.isArray(root) ? root : [root]) walk(node);
  return out;
}

/** True when some Text shows the number `n` as a number (not as part of a longer one). */
function showsNumber(n: number): boolean {
  const pattern = new RegExp(`(^|[^0-9])${n}([^0-9]|$)`);
  return screenTexts().some(text => pattern.test(text));
}

/** Opens every closed disclosure on screen. */
async function openEveryWhy() {
  for (let guard = 0; guard < 30; guard += 1) {
    const next = screen.queryAllByTestId(/-why$/).find(node => node.props.accessibilityState?.expanded !== true);
    if (!next) return;
    await fireEvent.press(next);
  }
}

type Host = { parent: Host | null; props: Record<string, unknown> };
function ancestors(node: Host): Host[] {
  const out: Host[] = [];
  for (let at: Host | null = node; at; at = at.parent) out.push(at);
  return out;
}
function hostText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object' || !('children' in node)) return '';
  return ((node as { children?: unknown[] }).children ?? []).map(hostText).join('');
}

/** The old count line, the declined note and the disconnect sentence are not on screen as they were. */
function expectOldBlockGone() {
  expect(screenTexts().filter(text => text.includes(OLD.busyCountTail))).toEqual([]);
  expect(screenTexts().filter(text => text.includes(OLD.disconnectBody))).toEqual([]);
  expect(screenTexts().filter(text => text.includes(OLD.declinedNote))).toEqual([]);
}

describe('B2 calendar: the busy block depends on whether reading is actually on', () => {
  it('B2 calendar (reading on, nothing busy): no "0 busy" count and none of the old block', async () => {
    await showReading();
    expect(screen.queryAllByText(oldBusyCount(0), { exact: false })).toHaveLength(0);
    expect(showsNumber(0)).toBe(false);
    expectOldBlockGone();
    expect(screen.queryByTestId('calendar-disconnect')).not.toBeNull();
  });

  it('B2 calendar (reading on, 3 busy): the count is shown, not as the old uninflected line', async () => {
    jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue(blocks(3));
    await seedCache(3);
    await showReading();
    expect(showsNumber(3)).toBe(true);
    expectOldBlockGone();
    expect(screen.queryByTestId('calendar-disconnect')).not.toBeNull();
  });

  const OFF_STATES: [string, () => void, string][] = [
    ['permission denied', () => { jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('denied'); }, 'calendar-permission-denied'],
    ['consent off', () => { consent = false; }, 'calendar-read-allow'],
    ['feature disabled', () => { process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ = 'false'; }, 'calendar-read-unavailable'],
  ];
  for (const [state, arrange, marker] of OFF_STATES) {
    it(`B2 calendar (${state}): a cached busy read is not presented as current, and disconnect stays`, async () => {
      await seedCache(7);
      arrange();
      await show();
      await waitFor(() => expect(screen.queryByTestId(marker)).not.toBeNull());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
      await openEveryWhy();
      expect(showsNumber(7)).toBe(false);
      expect(showsNumber(0)).toBe(false);
      expectOldBlockGone();
      // The disconnect action is on this screen in every state today.
      expect(screen.queryByTestId('calendar-disconnect')).not.toBeNull();
    });
  }
});

describe('B2 calendar: the declined note and the disconnect explanation sit behind a why by the disconnect button', () => {
  it('B2 calendar (Android): hidden until a why near the disconnect button is opened; the button and its confirm still work', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    await showReading();
    expect(screenTexts().filter(text => text.includes(OLD.disconnectBody) || text.includes(OLD.declinedNote))).toEqual([]);

    await openEveryWhy();
    const bodies = screen.queryAllByTestId(/-why-body$/);
    const disconnectWhy = bodies.find(body => hostText(body).includes(OLD.disconnectBody));
    const declinedWhy = bodies.find(body => hostText(body).includes(OLD.declinedNote));
    expect(disconnectWhy).toBeDefined();
    expect(declinedWhy).toBeDefined();

    // "Next to the disconnect button": the explanation and the button share a
    // container that does not also hold the reading switch at the top.
    const button = screen.getByTestId('calendar-disconnect') as unknown as Host;
    const shared = ancestors(disconnectWhy as unknown as Host).find(node => ancestors(button).includes(node));
    expect(shared).toBeDefined();
    const holdsReadToggle = ancestors(screen.getByTestId('calendar-read-toggle') as unknown as Host).includes(shared!);
    expect(holdsReadToggle).toBe(false);

    await fireEvent.press(screen.getByTestId('calendar-disconnect'));
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-dialog')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-disconnect-confirm'));
    await waitFor(() => expect(calendarEndpoints.deleteCalendarBusy).toHaveBeenCalledTimes(1));
  });
});

describe('B2 calendar: raw system names are never shown', () => {
  const CASES: [string, Partial<DeviceEventCalendar>][] = [
    ['exact token as title', { title: 'calendar_displayname_local', sourceName: 'anas@gmail.com' }],
    ['exact token as source', { title: 'Calendar', sourceName: 'calendar_displayname_local' }],
    ['generalized token as title', { title: 'calendar_displayname_personal', sourceName: 'anas@gmail.com' }],
    ['generalized token as source', { title: 'Calendar', sourceName: 'account_displayname_default' }],
  ];
  for (const [name, overrides] of CASES) {
    it(`B2 calendar (${name}): list text, group heading, switch label and write-picker label say the phone-calendar name`, async () => {
      const calendar: DeviceEventCalendar = { id: 'tok', title: 'Calendar', color: null, sourceName: null, ...overrides };
      const writable: WritableCalendar = { id: 'tok', title: calendar.title, color: null, isPrimary: false, sourceName: calendar.sourceName };
      process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE = 'true';
      jest.spyOn(calendarEndpoints, 'getCalendarSettings')
        .mockResolvedValue({ success: true, calendarSettings: { writeTarget: 'device', updatedAt: null } } as never);
      jest.spyOn(deviceCalendar, 'listEventCalendars').mockResolvedValue([calendar]);
      jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([writable]);
      await show();
      await waitFor(() => expect(screen.queryByTestId('calendar-device-tok')).not.toBeNull());
      await waitFor(() => expect(screen.queryByTestId('calendar-option-tok')).not.toBeNull());

      // Nowhere on screen, read or spoken.
      expect(screenTexts().filter(text => /displayname/i.test(text))).toEqual([]);
      expect(screenLabels().filter(label => /displayname/i.test(label))).toEqual([]);

      // The phone's own calendar, named for a person.
      expect(screenTexts().some(text => text.includes(PHONE_CALENDAR))).toBe(true);
      expect(String(screen.getByTestId('calendar-device-tok').props.accessibilityLabel)).toContain(PHONE_CALENDAR);
      expect(String(screen.getByTestId('calendar-option-tok').props.accessibilityLabel)).toContain(PHONE_CALENDAR);
    });
  }
});

describe('B5 counts: the busy count is an ICU plural', () => {
  it('B5 calendar busy count: 1, 2, 3 and 11 each read in their own Arabic form', async () => {
    const forms: string[] = [];
    for (const n of [1, 2, 3, 11]) {
      resetBusySyncForTests();
      client.clear();
      jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue(blocks(n));
      await seedCache(n);
      await showReading();
      // Everything on screen with the digits taken out: only the count's own
      // words can differ between the four renders.
      forms.push(JSON.stringify([...new Set(screenTexts().map(text => text.replace(/[0-9٠-٩]/g, '')))].sort()));
      await cleanup();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    // Arabic has a distinct form for one, two, few (3–10) and many (11–99).
    expect(new Set(forms).size).toBe(4);
  });
});

describe('B2 calendar: what only a device shows', () => {
  it.todo('B2 calendar: with reading on, the block says in one practical line what reading does for the user (new copy, R-B2): needs simulator');
  it.todo('B2 calendar: a real Android resource-id calendar renders as the phone-calendar name in the list (R-B2): needs simulator');
});
