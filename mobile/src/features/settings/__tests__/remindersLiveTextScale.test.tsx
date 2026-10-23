/**
 * Settings → Reminders follows a text-size change made while it is open
 * (simulator 2026-10-24, shots 51a, 52 and 53).
 *
 * Growing to AX5 «رجوع» disappeared and the «الإشعارات مسكّرة» line and
 * «افتح إعدادات التلفون» were slivers; back at the default size the card
 * stayed 795 pt tall and the button 188 pt with its label at the top. None of
 * those words change with the scale, so native kept the old measurement. The
 * card's paragraphs sit in views that say them and stay (`SaidWords`); the
 * words in «رجوع» and the button are replaced by the button's own boundary
 * (`Btn`), the buttons stay.
 *
 * Real `useWindowDimensions` and `Dimensions.set`; the default reading is
 * restored after each test.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { NotificationsSettingsScreen } from '../NotificationsSettingsScreen';
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import * as planEndpoints from '../../../api/endpoints/plans';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as permission from '../../../notifications/permission';
import reminderFixture from '../../../api/__fixtures__/reminders.settingsDefault.json';
import type { NotificationPermission } from '../../../notifications/permission';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const AX5 = 3.12;
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = { uid: 'reminders-live-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

let client: QueryClient;

beforeEach(() => {
  setFontScale(1);
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  setAuthRepository(createFakeAuthRepository({ initialUser: USER }));
  jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(reminderFixture as never);
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ success: true, routine: null } as never);
  jest.spyOn(planEndpoints, 'getPlanSettings').mockResolvedValue({
    enabled: false, deliveryLocalTime: '07:30', timezone: 'Asia/Jerusalem', nextRunAt: null, continuousReplanEnabled: true,
  } as never);
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  setFontScale(1);
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

type Host = ReturnType<typeof screen.getByTestId>;
type Style = Record<string, unknown>;
const flat = (node: Host) => (StyleSheet.flatten(node.props.style) ?? {}) as Style;
const drawnIn = (id: string) => within(screen.getByTestId(id)).getAllByText(/./, { includeHiddenElements: true });

async function show(answer: NotificationPermission, ready: string) {
  jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue(answer);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository({ initialUser: USER })} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <NotificationsSettingsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId(ready)).not.toBeNull());
}

async function expectRemeasured(regions: readonly string[], kept: readonly string[]) {
  const stable = kept.map((id) => screen.getByTestId(id));
  let drawn = regions.flatMap(drawnIn);
  expect(drawn.length).toBeGreaterThanOrEqual(regions.length);
  for (const scale of [AX5, 1]) {
    await act(async () => { setFontScale(scale); });
    const next = regions.flatMap(drawnIn);
    expect(next).toHaveLength(drawn.length);
    for (const node of next) expect(drawn).not.toContain(node);
    kept.forEach((id, i) => expect(screen.getByTestId(id)).toBe(stable[i]));
    drawn = next;
  }
}

describe('the reminders screen after a live text-size change', () => {
  it('denied: the line is said by a view that stays, «رجوع» and «افتح إعدادات التلفون» keep their buttons, every drawn paragraph is new', async () => {
    await show('denied', 'notifications-denied-said');
    const said = screen.getByTestId('notifications-denied-said');
    expect(said.props.accessible).toBe(true);
    expect(said.props.accessibilityLabel).toBe(screen.getByTestId('notifications-denied').props.children);
    expect(screen.getByTestId('notifications-denied').props.accessible).toBe(false);
    await expectRemeasured(
      ['notifications-denied-said', 'notifications-open-settings', 'header-back'],
      ['notifications-denied-said', 'notifications-open-settings', 'header-back', 'notifications-status', 'notifications-status-live'],
    );
  });

  // Q-LIVE2-001: Android hears any subtree replacement in a live region as
  // new content, so the card that replaces its words must sit outside it, and
  // the region's one node must survive a text-size change untouched.
  it('denied: the live region holds one childless node that a text-size change leaves alone, and the card sits outside it', async () => {
    await show('denied', 'notifications-denied-said');
    const region = screen.getByTestId('notifications-status-live');
    expect(region.props.accessibilityLiveRegion).toBe('polite');
    expect(within(region).queryByTestId('notifications-status')).toBeNull();
    expect(within(region).queryByTestId('notifications-open-settings')).toBeNull();
    const node = screen.getByTestId('notifications-status-live-said', { includeHiddenElements: true });
    const label = node.props.accessibilityLabel;
    expect(label).toBe(screen.getByTestId('notifications-denied').props.children);
    expect(node.children).toHaveLength(0);
    // iOS has no live regions: VoiceOver reads the card, not this node.
    expect(node.props.accessibilityElementsHidden).toBe(true);
    for (const scale of [AX5, 1, AX5]) {
      await act(async () => { setFontScale(scale); });
      expect(screen.getByTestId('notifications-status-live')).toBe(region);
      expect(screen.getByTestId('notifications-status-live-said', { includeHiddenElements: true })).toBe(node);
      expect(node.props.accessibilityLabel).toBe(label);
      expect(node.children).toHaveLength(0);
    }
  });

  it('not asked yet: the line above «اسمح» is said by a view that stays, the button keeps its node', async () => {
    await show('undetermined', 'notifications-allow-body');
    expect(screen.getByTestId('notifications-allow-body').props.accessible).toBe(true);
    await expectRemeasured(['notifications-allow-body', 'notifications-allow'], ['notifications-allow-body', 'notifications-allow']);
  });

  it('default → AX5 → default: the card and its button commit what a fresh open commits, with no flex basis', async () => {
    await show('denied', 'notifications-denied-said');
    const read = () => ({
      card: flat(screen.getByTestId('notifications-status')),
      line: flat(screen.getByTestId('notifications-denied-said')),
      button: flat(screen.getByTestId('notifications-open-settings')),
      header: flat(screen.getByTestId('back-header')),
    });
    const fresh = read();
    await act(async () => { setFontScale(AX5); });
    const ax5 = read();
    expect(ax5.header.flexDirection).toBe('column');
    await act(async () => { setFontScale(1); });
    expect(read()).toEqual(fresh);
    for (const style of [...Object.values(fresh), ...Object.values(ax5)]) {
      expect(style.flex).toBeUndefined();
      expect(style.flexBasis).toBeUndefined();
    }
  });
});
