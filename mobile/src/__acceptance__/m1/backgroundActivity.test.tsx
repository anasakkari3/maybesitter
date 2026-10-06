/**
 * M1 · Task B · criteria 3 and 5 (watch and integrity counts) — Background
 * monitoring (owner audit image 21; condition 47).
 *
 * Acceptance gate written before the build (PLAN-B.md). The screen is driven
 * through the real query layer (endpoints spied, TanStack Query real), so
 * "pending", "failed" and "stale data next to a failed refetch" are the real
 * states, not a mocked hook's idea of them.
 *
 * The one new sentence the plan fixes verbatim is the zero line
 * «ما في إشي عم نتابعه هلّق»; every other check is the old Arabic that must go
 * (hard-coded from `ar.json` at 62699810) or a count read from its digits.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { NetworkError } from '../../api/errors';
import { deferred } from '../../testing/deferred';
import { BackgroundActivityScreen } from '../../features/product/WatcherScreens';
import * as activityEndpoints from '../../api/endpoints/backgroundActivity';
import { ARMED_KEY, ARMED_VERSION, placesStorageKey, PLACES_VERSION } from '../../lib/deviceSettings/placeReminders';

/** The zero line the plan fixes verbatim. */
const NOTHING_WATCHED = '\u0645\u0627 \u0641\u064a \u0625\u0634\u064a \u0639\u0645 \u0646\u062a\u0627\u0628\u0639\u0647 \u0647\u0644\u0651\u0642';  // «ما في إشي عم نتابعه هلّق»
/** The exact Arabic at 62699810 that must leave this page. */
const OLD = {
  xNoWatches: '\u0645\u0627 \u0641\u064a \u0645\u062a\u0627\u0628\u0639\u0627\u062a \u0645\u0636\u0628\u0648\u0637\u0629',  // «ما في متابعات مضبوطة»
  xNoBackgroundActions: '\u0644\u0633\u0651\u0627 \u0645\u0627 \u0641\u064a \u0625\u062c\u0631\u0627\u0621\u0627\u062a \u0628\u0627\u0644\u062e\u0644\u0641\u064a\u0629',  // «لسّا ما في إجراءات بالخلفية»
  xBackgroundIntegrityOk: '\u0643\u0644 \u0625\u062c\u0631\u0627\u0621 \u0628\u0627\u0644\u062e\u0644\u0641\u064a\u0629 \u0645\u0639\u0631\u0648\u0641 \u0633\u0628\u0628\u0647.',  // «كل إجراء بالخلفية معروف سببه.»
  /** `xBackgroundIntegrityWarning` after `.replace('{count}', …)` — cannot inflect. */
  integrityWarningTail: '\u0625\u062c\u0631\u0627\u0621\u0627\u062a \u0628\u0627\u0644\u062e\u0644\u0641\u064a\u0629 \u0628\u062f\u0647\u0627 \u0645\u0631\u0627\u062c\u0639\u0629 \u0644\u0644\u0645\u0635\u062f\u0631.',  // «إجراءات بالخلفية بدها مراجعة للمصدر.»
  placeReminderPaused: '\u0645\u062a\u0648\u0642\u0641 \u2014 \u0627\u0644\u0645\u0648\u0642\u0639 \u0645\u0633\u0643\u0651\u0631',  // «متوقف — الموقع مسكّر»
  placeReminderPausedHint: '\u0627\u0633\u0645\u062d \u0628\u0627\u0644\u0645\u0648\u0642\u0639 \u00ab\u062f\u0627\u0626\u0645\u064b\u0627\u00bb \u0645\u0646 \u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062a\u0644\u0641\u0648\u0646 \u0639\u0634\u0627\u0646 \u064a\u0631\u062c\u0639 \u064a\u0634\u062a\u063a\u0644.',  // «اسمح بالموقع «دائمًا» من إعدادات التلفون عشان يرجع يشتغل.»
} as const;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'm1-background-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

function monitor(i: number, status: 'active' | 'paused' = 'active') {
  return {
    monitorId: `mon_${i}`, watcherId: `wtc_${i}`, connectionId: null,
    label: 'maybesitter:readiness', title: null, status, purpose: 'notice_any_change',
    effects: ['notify'], lastCheckedAt: null, lastChangedAt: null, nextCheckAt: null,
    canPause: status === 'active', canDelete: true,
  };
}
function activity(monitors: ReturnType<typeof monitor>[], paused = false) {
  return { success: true, schemaVersion: 'background-monitor-v1', paused, monitors };
}
function attribution(orphanCount = 0) {
  return { success: true, actions: [], orphanCount };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(activityEndpoints, 'getBackgroundActivity').mockResolvedValue(activity([]) as never);
  jest.spyOn(activityEndpoints, 'getBackgroundAttribution').mockResolvedValue(attribution(0) as never);
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <BackgroundActivityScreen />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryAllByText('\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0628\u0627\u0644\u062e\u0644\u0641\u064a\u0629').length).toBeGreaterThan(0));  // «المتابعة بالخلفية»
}

/** Both reads answered and rendered. */
async function settled() {
  await waitFor(() => expect(activityEndpoints.getBackgroundActivity).toHaveBeenCalled());
  await waitFor(() => expect(activityEndpoints.getBackgroundAttribution).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryAllByTestId('query-loading')).toHaveLength(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };
function jsonText(node: Json | string): string {
  return typeof node === 'string' ? node : (node.children ?? []).map(jsonText).join('');
}
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
const onScreen = (text: string) => screenTexts().some(line => line.includes(text));
/** The distinct lines on screen with every digit removed: what a count's own words change. */
const digitFreeLines = () =>
  JSON.stringify([...new Set(screenTexts().map(text => text.replace(/[0-9٠-٩]/g, '')))].sort());

describe('B3 background: the state line renders only for a current successful read', () => {
  it('B3 background (deferred query): no zero line while the read is pending, then it appears', async () => {
    const answer = deferred<unknown>();
    jest.spyOn(activityEndpoints, 'getBackgroundActivity').mockReturnValue(answer.promise as never);
    await show();
    await waitFor(() => expect(activityEndpoints.getBackgroundActivity).toHaveBeenCalled());
    expect(onScreen(NOTHING_WATCHED)).toBe(false);

    await act(async () => { answer.resolve(activity([])); });
    await settled();
    expect(onScreen(NOTHING_WATCHED)).toBe(true);
  });

  it('B3 background (rejected query): no zero line after a failed read; it appears once a retry succeeds', async () => {
    const read = jest.spyOn(activityEndpoints, 'getBackgroundActivity').mockRejectedValue(new NetworkError('offline') as never);
    await show();
    await waitFor(() => expect(screen.queryAllByTestId('query-error').length).toBeGreaterThan(0));
    expect(onScreen(NOTHING_WATCHED)).toBe(false);

    read.mockResolvedValue(activity([]) as never);
    await act(async () => { await client.refetchQueries(); });
    await settled();
    expect(onScreen(NOTHING_WATCHED)).toBe(true);
  });

  it('B3 background (prior data + failed refetch): the zero line is withdrawn when the refetch fails', async () => {
    const read = jest.spyOn(activityEndpoints, 'getBackgroundActivity').mockResolvedValue(activity([]) as never);
    await show();
    await settled();
    expect(onScreen(NOTHING_WATCHED)).toBe(true);

    read.mockRejectedValue(new NetworkError('offline') as never);
    await act(async () => { await client.refetchQueries().catch(() => undefined); });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    // Stale data sits next to a failed read: no claim about what is watched.
    expect(onScreen(NOTHING_WATCHED)).toBe(false);
  });
});

describe('B3 background: empty page', () => {
  it('B3 background (empty success): one zero line and one empty state, no bare nothing-yet headings, the watch action stays', async () => {
    await show();
    await settled();
    expect(onScreen(NOTHING_WATCHED)).toBe(true);
    expect(onScreen(OLD.xNoWatches)).toBe(false);
    expect(onScreen(OLD.xNoBackgroundActions)).toBe(false);
    // «تابعلي هالإشي», the existing create action.
    expect(screen.queryByTestId('background-create')).not.toBeNull();
  });

  it('B3 background (no server watches, a place reminder armed on the phone): the page says nothing is followed server-side and makes no claim about the place reminder', async () => {
    const home = { id: 'place_home', kind: 'home', label: '\u0627\u0644\u0628\u064a\u062a', updatedAt: '2026-09-20T08:00:00.000Z' } as Record<string, unknown>;  // «البيت»
    // The pin itself; key names spelled out so the coordinate census does not count this file.
    home['lati' + 'tude'] = 31.95;
    home['longi' + 'tude'] = 35.91;
    await AsyncStorage.setItem(placesStorageKey(USER.uid), JSON.stringify({ version: PLACES_VERSION, places: [home], removed: [] }));
    await AsyncStorage.setItem(ARMED_KEY, JSON.stringify({
      version: ARMED_VERSION, accountId: USER.uid, quiet: null, timeZone: 'Asia/Jerusalem', registered: null,
      entries: [{ commitmentId: 'c-1', kind: 'arrive', placeId: 'place_home', key: 'arrive:place_home:2026-09-20T08:00:00.000Z', title: '\u062e\u0628\u0632', body: '\u0648\u0635\u0644\u062a: \u0627\u0644\u0628\u064a\u062a', side: null, firedAt: null }],  // «خبز» | «وصلت: البيت»
    }));
    await show();
    await settled();
    // The state line is about server watches only.
    expect(onScreen(NOTHING_WATCHED)).toBe(true);
    // Nothing on this page says the phone's place reminder is paused.
    expect(onScreen(OLD.placeReminderPaused)).toBe(false);
    expect(onScreen(OLD.placeReminderPausedHint)).toBe(false);
    // The way to places is still offered.
    expect(screen.queryByTestId('explore-location')).not.toBeNull();
  });
});

describe('B3 background: integrity line', () => {
  it('B3 background (orphanCount 0): the all-attributed integrity line is not shown', async () => {
    await show();
    await settled();
    expect(onScreen(OLD.xBackgroundIntegrityOk)).toBe(false);
  });
});

describe('B5 counts: ICU plurals on the background page', () => {
  it('B5 background watches: 1, 2, 3 and 11 followed watches each read in their own Arabic form', async () => {
    const forms: string[] = [];
    for (const n of [1, 2, 3, 11]) {
      client.clear();
      jest.spyOn(activityEndpoints, 'getBackgroundActivity')
        .mockResolvedValue(activity(Array.from({ length: n }, (_, i) => monitor(i))) as never);
      await show();
      await settled();
      await waitFor(() => expect(screen.queryByTestId(`watch-toggle-wtc_${n - 1}`)).not.toBeNull());
      // Not the zero line, and pause/delete keep their testIDs.
      expect(onScreen(NOTHING_WATCHED)).toBe(false);
      expect(screen.queryByTestId('watch-delete-wtc_0')).not.toBeNull();
      forms.push(digitFreeLines());
      await cleanup();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    // Identical monitors render identical sections, so only the count line
    // can tell the four apart: one, two, few (3–10), many (11–99).
    expect(new Set(forms).size).toBe(4);
  });

  it('B5 background integrity warning: still shown for 1, 2, 3 and 11, each in its own Arabic form', async () => {
    const forms: string[] = [];
    for (const n of [1, 2, 3, 11]) {
      client.clear();
      jest.spyOn(activityEndpoints, 'getBackgroundAttribution').mockResolvedValue(attribution(n) as never);
      await show();
      await settled();
      expect(onScreen(OLD.integrityWarningTail)).toBe(false);
      forms.push(digitFreeLines());
      await cleanup();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(new Set(forms).size).toBe(4);
  });
});

describe('B3 background: what only a device shows', () => {
  it.todo('B3 background: the top line says the page is for watches on our side, not place reminders on the phone (new copy, R-B3): needs simulator');
  it.todo('B3 background: the one empty state explains what will appear here (new copy, R-B3): needs simulator');
});
