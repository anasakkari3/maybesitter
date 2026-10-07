/**
 * M1 · Task B · criterion 1 — the Reminders screen (owner audit images 5–7).
 *
 * Acceptance gate written before the build (PLAN-B.md). Each test asserts only
 * what a person sees: the old Arabic sentences that must disappear (copied
 * from `ar.json` at 62699810 and hard-coded, because the keys may go), and the
 * Disclosure contract from `ui/Disclosure.tsx` (`${id}-why` opens
 * `${id}-why-body`). The Disclosure ids are the builder's choice, so the tests
 * find every `*-why` control inside the card the setting lives in rather than
 * guessing an id.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { NotificationsSettingsScreen } from '../../features/settings/NotificationsSettingsScreen';
import * as reminderEndpoints from '../../api/endpoints/reminders';
import * as planEndpoints from '../../api/endpoints/plans';
import * as profileEndpoints from '../../api/endpoints/profile';
import * as permission from '../../notifications/permission';
import * as deviceEndpoints from '../../api/endpoints/devices';
import * as messaging from '@react-native-firebase/messaging';
import { resetInstallationIdForTests } from '../../lib/installationId';
import settingsFixture from '../../api/__fixtures__/reminders.settingsSaved.json';
import planDefault from '../../api/__fixtures__/plan.settingsDefault.json';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar-JO', textDirection: 'rtl' }]),
}));

// The text size is part of the criterion ("normal and XL text layouts"), so
// it is set per test rather than left at the jest mock's default.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions').default as jest.Mock;

/** The exact Arabic at 62699810 — the text that must leave the screen. */
const OLD = {
  notifIntroOn: 'MaybeSitter \u0628\u064a\u0630\u0643\u0651\u0631\u0643 \u0628\u0627\u0644\u0623\u0648\u0642\u0627\u062a \u0627\u0644\u0644\u064a \u0627\u062e\u062a\u0631\u062a\u0647\u0627\u060c \u0648\u0645\u0627 \u0628\u064a\u0632\u0639\u062c\u0643 \u0628\u0633\u0627\u0639\u0627\u062a \u0647\u062f\u0648\u0626\u0643.',  // «MaybeSitter بيذكّرك بالأوقات اللي اخترتها، وما بيزعجك بساعات هدوئك.»
  notifIntroAsk: 'MaybeSitter \u0628\u064a\u0630\u0643\u0651\u0631\u0643 \u0628\u0627\u0644\u0623\u0648\u0642\u0627\u062a \u0627\u0644\u0644\u064a \u0627\u062e\u062a\u0631\u062a\u0647\u0627. \u062a\u0644\u0641\u0648\u0646\u0643 \u0631\u062d \u064a\u0633\u0623\u0644\u0643 \u0623\u0648\u0644 \u0645\u0627 \u062a\u0634\u063a\u0651\u0644 \u0627\u0644\u062a\u0630\u0643\u064a\u0631\u0627\u062a.',  // «MaybeSitter بيذكّرك بالأوقات اللي اخترتها. تلفونك رح يسألك أول ما تشغّل التذكيرات.»
  notifQuietBody: '\u0645\u0627 \u0628\u064a\u0648\u0635\u0644\u0643 \u0625\u0634\u064a \u0628\u0647\u0627\u0644\u0633\u0627\u0639\u0627\u062a. \u0648\u0627\u0644\u062a\u0630\u0643\u064a\u0631 \u0627\u0644\u0644\u064a \u0628\u064a\u0648\u0642\u0639 \u0641\u064a\u0647\u0627 \u0628\u064a\u0633\u062a\u0646\u0651\u0649 \u0644\u062d\u062f \u0645\u0627 \u062a\u062e\u0644\u0635.',  // «ما بيوصلك إشي بهالساعات. والتذكير اللي بيوقع فيها بيستنّى لحد ما تخلص.»
  notifGentleBody: '\u062a\u0646\u0628\u064a\u0647 \u0647\u0627\u062f\u064a \u0642\u0628\u0644 \u0625\u0634\u064a \u062d\u0627\u0637\u0637\u0644\u0647 \u0648\u0642\u062a. \u0628\u064a\u0648\u0642\u0641 \u0623\u0648\u0644 \u0645\u0627 \u062a\u0642\u0648\u0644 \u0625\u0646\u0643 \u0639\u0627\u0631\u0641.',  // «تنبيه هادي قبل إشي حاططله وقت. بيوقف أول ما تقول إنك عارف.»
  notifMustQuietBody: '\u0628\u0633 \u0627\u0644\u0631\u0646\u0651\u0629 \u0627\u0644\u0644\u064a \u0642\u0628\u0644 \u0627\u0644\u0625\u0634\u064a \u0627\u0644\u0636\u0631\u0648\u0631\u064a \u0628\u064010 \u062f\u0642\u0627\u064a\u0642. \u0643\u0644 \u0625\u0634\u064a \u062a\u0627\u0646\u064a \u0628\u064a\u0633\u062a\u0646\u0651\u0649 \u0644\u062d\u062f \u0645\u0627 \u062a\u062e\u0644\u0635 \u0633\u0627\u0639\u0627\u062a \u0627\u0644\u0647\u062f\u0648\u0621.',  // «بس الرنّة اللي قبل الإشي الضروري بـ10 دقايق. كل إشي تاني بيستنّى لحد ما تخلص ساعات الهدوء.»
  planMorningBody: '\u0643\u0644 \u0635\u0628\u062d \u0645\u0646\u0631\u062a\u0651\u0628 \u064a\u0648\u0645\u0643 \u0648\u0645\u0646\u0628\u0639\u062a\u0644\u0643 \u0625\u0634\u0639\u0627\u0631 \u0648\u062d\u062f\u0629 \u0644\u0645\u0627 \u062a\u062c\u0647\u0632. \u0648\u0625\u0646\u062a \u0628\u062a\u0642\u0631\u0651\u0631 \u0634\u0648 \u0628\u062f\u0651\u0643 \u062a\u0639\u0645\u0644 \u0641\u064a\u0647\u0627.',  // «كل صبح منرتّب يومك ومنبعتلك إشعار وحدة لما تجهز. وإنت بتقرّر شو بدّك تعمل فيها.»
  planReplanBody: '\u0644\u0645\u0627 \u064a\u062a\u063a\u064a\u0651\u0631 \u0625\u0634\u064a \u0628\u064a\u0648\u0645\u0643\u060c \u0645\u0646\u0642\u062f\u0631 \u0646\u0631\u062a\u0651\u0628 \u062e\u0637\u062a\u0643 \u0645\u0646 \u062c\u062f\u064a\u062f \u0644\u062a\u0632\u0628\u0637. \u062a\u062d\u0631\u064a\u0643 \u0627\u0644\u0648\u0642\u062a \u0627\u0644\u0635\u063a\u064a\u0631 \u0628\u0635\u064a\u0631 \u0644\u062d\u0627\u0644\u0647\u060c \u0648\u0623\u064a \u062a\u063a\u064a\u064a\u0631 \u0623\u0643\u0628\u0631 \u0628\u0633\u062a\u0646\u0651\u0649 \u0645\u0648\u0627\u0641\u0642\u062a\u0643. \u0625\u0637\u0641\u0627\u0624\u0647 \u0645\u0627 \u0628\u064a\u0641\u0635\u0644 \u062a\u0642\u0648\u064a\u0645\u0627\u062a\u0643.',  // «لما يتغيّر إشي بيومك، منقدر نرتّب خطتك من جديد لتزبط. تحريك الوقت الصغير بصير لحاله، وأي تغيير أكبر بستنّى موافقتك. إطفاؤه ما بيفصل تقويماتك.»
  planReplanNoBackfill: '\u0644\u0648 \u0631\u062c\u0651\u0639\u062a \u0634\u063a\u0651\u0644\u062a\u0647\u060c \u0627\u0644\u062a\u063a\u064a\u064a\u0631\u0627\u062a \u0627\u0644\u0644\u064a \u0635\u0627\u0631\u062a \u0648\u0647\u0648 \u0645\u0637\u0641\u0651\u064a \u0645\u0627 \u0631\u062d \u0646\u0631\u062c\u0639 \u0646\u0644\u062d\u0642\u0647\u0627.',  // «لو رجّعت شغّلته، التغييرات اللي صارت وهو مطفّي ما رح نرجع نلحقها.»
} as const;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'm1-reminders-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function settings(overrides: Partial<typeof settingsFixture.reminderSettings> = {}) {
  return { ...settingsFixture, reminderSettings: { ...settingsFixture.reminderSettings, ...overrides } };
}
/** Must items ring: the state in which the "through quiet hours" switch exists. */
const ringing = () => settings({ hardEnabled: true, escalationCeiling: 'hard' });

beforeEach(async () => {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(settings() as never);
  jest.spyOn(reminderEndpoints, 'putReminderSettings').mockResolvedValue(settings() as never);
  jest.spyOn(planEndpoints, 'getPlanSettings').mockResolvedValue(planDefault.planSettings as never);
  jest.spyOn(planEndpoints, 'putPlanSettings').mockResolvedValue(planDefault.planSettings as never);
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ success: true, routine: null } as never);
  jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('granted');
  jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('granted');
  resetInstallationIdForTests();
  jest.spyOn(messaging, 'getToken').mockResolvedValue('a-real-looking-fcm-token-aaaaaaaaaaaaaaaaaaaaaaa' as never);
  jest.spyOn(deviceEndpoints, 'registerDevice').mockResolvedValue({ success: true, ok: true } as never);
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

/** Renders the screen in Arabic and waits until the server's answers have landed. */
async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <NotificationsSettingsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  // Arabic is on screen (the language is read from storage on mount)…
  await waitFor(() => expect(screen.queryAllByText('\u0627\u0644\u062a\u0630\u0643\u064a\u0631\u0627\u062a').length).toBeGreaterThan(0));  // «التذكيرات»
  // …and both records have answered, so every conditional section is drawn.
  await waitFor(() => expect(screen.getByTestId('gentle-reminders-switch').props.accessibilityState?.disabled).toBe(false));
  await waitFor(() => expect(screen.getByTestId('plan-replan-toggle').props.disabled).toBe(false));
}

/** All the text a rendered node carries, its own and its descendants'. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object' || !('children' in node)) return '';
  const children = (node as { children?: unknown[] }).children ?? [];
  return children.map(textOf).join('');
}

/** Every "why" control inside `scope` (or the whole screen) that is still closed. */
function closedWhys(scope?: ReturnType<typeof within>) {
  const found = scope ? scope.queryAllByTestId(/-why$/) : screen.queryAllByTestId(/-why$/);
  return found.filter(node => node.props.accessibilityState?.expanded !== true);
}

/** Opens every disclosure on the screen, so "absent" means absent, not merely folded away. */
async function openEveryWhy() {
  for (let guard = 0; guard < 30; guard += 1) {
    const next = closedWhys()[0];
    if (!next) return;
    await fireEvent.press(next);
  }
}

/**
 * The explanation `text` is not on screen until a "why" inside `cardTestID`
 * is opened, and then it is inside a `*-why-body` in that same card.
 */
async function expectBehindWhy(cardTestID: string, text: string) {
  expect(screen.queryAllByText(text, { exact: false })).toHaveLength(0);
  const card = within(screen.getByTestId(cardTestID));
  const whys = closedWhys(card);
  expect(whys.length).toBeGreaterThan(0);
  for (const why of whys) {
    expect(why.props.accessibilityRole).toBe('button');
    expect(typeof why.props.accessibilityLabel).toBe('string');
  }
  for (const why of closedWhys(card)) await fireEvent.press(why);
  const bodies = within(screen.getByTestId(cardTestID)).queryAllByTestId(/-why-body$/);
  const holding = bodies.filter(body => textOf(body).includes(text));
  expect(holding.length).toBe(1);
  return holding[0]!;
}

describe('B1 reminders: removed text', () => {
  it('B1 reminders: the intro card sentence is gone once the phone allows notifications', async () => {
    // Exception allowed by the plan: before the phone was ever asked, a
    // one-line explanation may stay in that ask state only. Here the phone has
    // answered yes, so neither intro sentence may be anywhere — not even behind
    // a disclosure.
    await show();
    await openEveryWhy();
    expect(screen.queryAllByText(OLD.notifIntroOn, { exact: false })).toHaveLength(0);
    expect(screen.queryAllByText(OLD.notifIntroAsk, { exact: false })).toHaveLength(0);
  });

  it('B1 reminders: the quiet-hours description is gone, and the quiet chips still show', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('reminder-quiet-standard')).not.toBeNull());
    await openEveryWhy();
    expect(screen.queryAllByText(OLD.notifQuietBody, { exact: false })).toHaveLength(0);
    for (const choice of ['none', 'early', 'standard', 'late']) {
      expect(screen.queryByTestId(`reminder-quiet-${choice}`)).not.toBeNull();
    }
  });
});

for (const [layout, fontScale] of [['normal', 1], ['XL', 2]] as const) {
  describe(`B1 reminders (${layout} text): explanations behind a why`, () => {
    beforeEach(() => {
      useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
    });

    it(`B1 reminders (${layout}): the gentle-reminders explanation is hidden until its why is opened`, async () => {
      await show();
      await expectBehindWhy('gentle-reminders', OLD.notifGentleBody);
      // The switch it explains still answers.
      expect(screen.getByTestId('gentle-reminders-switch').props.accessibilityState?.disabled).toBe(false);
    });

    it(`B1 reminders (${layout}): the Must-through-quiet-hours explanation is hidden until its why is opened`, async () => {
      jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(ringing() as never);
      await show();
      await waitFor(() => expect(screen.queryByTestId('must-through-quiet-switch')).not.toBeNull());
      await expectBehindWhy('must-reminders', OLD.notifMustQuietBody);
      expect(screen.queryByTestId('must-through-quiet-switch')).not.toBeNull();
    });

    it(`B1 reminders (${layout}): the morning-plan explanation is hidden until its why is opened`, async () => {
      await show();
      await expectBehindWhy('plan-settings', OLD.planMorningBody);
      expect(screen.queryByTestId('plan-morning-toggle')).not.toBeNull();
    });

    it(`B1 reminders (${layout}): the replan explanation and its no-backfill line share one why, hidden by default`, async () => {
      await show();
      expect(screen.queryByTestId('plan-replan-no-backfill')).toBeNull();
      expect(screen.queryAllByText(OLD.planReplanNoBackfill, { exact: false })).toHaveLength(0);
      const body = await expectBehindWhy('plan-settings', OLD.planReplanBody);
      // Folded into the same disclosure, not a second always-visible line.
      expect(textOf(body)).toContain(OLD.planReplanNoBackfill);
      expect(screen.queryByTestId('plan-replan-toggle')).not.toBeNull();
    });
  });
}

describe('B1 reminders: what only a device shows', () => {
  it.todo('B1 reminders: each why sits beside its setting title (title-accessory point), not around the whole bordered control: needs simulator');
  it.todo('B1 reminders: at accessibility-extra-extra-extra-large nothing is clipped and every why stays a 44-point target (R-B5): needs simulator');
});
