/**
 * The app, in Hebrew, driven the way a user drives it (UC-2.R5).
 *
 * ── What this file replaces ──────────────────────────────────────
 *
 * Until now every claim about Hebrew was a claim about `he.json`. The parity
 * test read the file, the plural test read the file, the no-commitment copy
 * test read the file. Not one of them rendered anything, because `Lang` was
 * `'ar' | 'en'` and `resolveLanguage` sent Hebrew to English, so a render would
 * have produced an English screen. Three test files say exactly that in their
 * own comments, which is how a whole language stayed one type away from
 * shipping while looking covered.
 *
 * So these tests do the one thing none of those could: put the app into Hebrew
 * through the same two doors a person has — a Hebrew phone, and the language
 * row in Settings — and then read what is actually on the screen. A regression
 * that takes Hebrew back out (a narrowed `Lang`, a `SELECTABLE_LOCALES` without
 * `he`, a `resolveLanguage` that falls back again) turns these red, and it
 * turns them red by rendering English words where Hebrew ones were asserted —
 * not by failing a lookup in a JSON file.
 *
 * ── What is still not proven here ────────────────────────────────
 *
 * That the Hebrew glyphs *draw*. Jest renders to objects, not pixels: this
 * asserts that the right face is asked for, and
 * `src/theme/__tests__/fontCoverage.test.ts` asserts that the face has the
 * glyphs. Rasterising them is a device's job and stays on the device issue.
 *
 * And that the copy is *good*. It is machine translated, it says so, and no
 * test can stand in for a native speaker reading it.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { Root } from '../../Root';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';
import { LANGUAGE_STORAGE_KEY } from '../language';
import * as language from '../language';

import * as captureEndpoints from '../../api/endpoints/capture';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../api/endpoints/analytics';
import * as trustEndpoints from '../../api/endpoints/trust';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'hebrew-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
  // Nothing here is a device, so the device language is whatever a case says.
  jest.spyOn(language, 'systemLanguageTag').mockReturnValue('en-US');
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

/** Start the app as somebody who already chose this language. */
async function openAppIn(lang: 'he' | 'ar' | 'en' | 'system') {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  // The stored preference is read in an effect, so the first frame is `system`;
  // the day is a query, so the first frame after that is a spinner. Wait for
  // both, or a case that reads the screen too early reads the wrong language.
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
  return view;
}

type Node = { props?: Record<string, unknown>; children?: unknown };

/** The first `direction` any box in the tree sets. Root sets exactly one. */
function renderedDirection(tree: unknown): string | undefined {
  const node = tree as Node | null;
  if (!node || typeof node !== 'object') return undefined;
  for (const style of [node.props?.style].flat(4)) {
    if (style && typeof style === 'object' && 'direction' in style) {
      return (style as { direction?: string }).direction;
    }
  }
  for (const child of [node.children].flat(2)) {
    const found = renderedDirection(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The font family a rendered `Txt` asks for. */
function fontOf(node: { props: Record<string, unknown> }): string | undefined {
  return [node.props.style].flat(4)
    .map(style => (style && typeof style === 'object' ? (style as { fontFamily?: string }).fontFamily : undefined))
    .find(name => typeof name === 'string');
}

describe('a Hebrew phone gets a Hebrew app', () => {
  it('reads right to left, in Hebrew, in a face that has Hebrew in it', async () => {
    const view = await openAppIn('he');

    // 1. The words are Hebrew — not the English they used to fall back to.
    expect(screen.queryByText(he.emptyTitle)).not.toBeNull();
    expect(screen.queryByText(en.emptyTitle)).toBeNull();

    // 2. The direction is RTL, set once on the root view exactly as for Arabic.
    expect(renderedDirection(view.toJSON())).toBe('rtl');

    // 3. The face is the Hebrew one. Outfit and Noto Naskh Arabic have no
    //    Hebrew glyphs at all (fontCoverage.test.ts measures it), so asking
    //    for either here is a screen of □□□ that no other test would catch.
    expect(fontOf(screen.getByText(he.emptyTitle))).toMatch(/^NotoSansHebrew_/);
  });

  it.each([
    ['he-IL', 'iOS'],
    // `iw` is the frozen pre-1989 code, and Android still reports it.
    ['iw-IL', 'Android'],
  ])('follows the device when it reports %s (%s)', async tag => {
    jest.spyOn(language, 'systemLanguageTag').mockReturnValue(tag);
    await openAppIn('system');
    expect(screen.queryByText(he.emptyTitle)).not.toBeNull();
  });

  it('still mirrors the other two languages the way it always did', async () => {
    const arabic = await openAppIn('ar');
    expect(renderedDirection(arabic.toJSON())).toBe('rtl');
    expect(fontOf(screen.getByText(ar.emptyTitle))).toMatch(/^NotoNaskhArabic_/);
    await arabic.unmount();

    const english = await openAppIn('en');
    expect(renderedDirection(english.toJSON())).toBe('ltr');
    expect(fontOf(screen.getByText(en.emptyTitle))).toMatch(/^Outfit_/);
  });
});

describe('the language row offers it', () => {
  it('cycles Arabic → עברית and turns the app Hebrew as it goes', async () => {
    await openAppIn('ar');
    await fireEvent.press(screen.getByRole('button', { name: ar.tabSettings }));
    await waitFor(() => expect(screen.queryByText(ar.sLanguage)).not.toBeNull());

    // System → English → العربية → עברית → System. From Arabic, one tap.
    await fireEvent.press(screen.getByRole('button', { name: ar.sLanguage }));

    await waitFor(() => expect(screen.queryByText(he.sLanguage)).not.toBeNull());
    // The row names the language in itself, so this is the picker's own label.
    expect(screen.queryByText('עברית')).not.toBeNull();
    // And the screen around it changed language, not just the one row.
    expect(screen.queryByText(ar.settingsTitle)).toBeNull();
    // getAllBy: «הגדרות» is both the screen title and the tab label, and that
    // both changed is the point — the row did not translate itself alone.
    expect(screen.getAllByText(he.settingsTitle).length).toBeGreaterThan(1);
  });
});

describe('the two surfaces the S2 issues name', () => {
  /**
   * UC-2.6 (#166): when the app created nothing, it says only that.
   *
   * `noCommitmentCopy.test.ts` already holds the Hebrew line to every rule the
   * issue sets — length, no advice, no question back. What it cannot do is
   * prove the line is the one a Hebrew user is shown, which is the half that
   * was actually broken: the copy existed and was unreachable.
   */
  it('#166: shows the Hebrew no-commitment line, and no English anywhere near it', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue({
      version: 'v1',
      proposalId: 'p-1',
      status: 'no_commitment',
      noCommitmentReason: 'greeting_or_chat',
      items: [],
      provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
    } as never);

    await openAppIn('he');
    await fireEvent.press(screen.getByTestId('tab-capture'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'מה נשמע');
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('capture-nothing')).not.toBeNull());

    expect(screen.getByTestId('capture-nothing-reason').props.children).toBe(he.noCommitmentGreetingOrChat);
    expect(screen.queryByText(en.noCommitmentGreetingOrChat)).toBeNull();
    // The issue's other rule, in the language it is being read in: nothing the
    // person wrote is quoted back at them.
    expect(screen.queryByText(/מה נשמע/)).toBeNull();
  });

  /**
   * UC-2.4 (#164) counts what it is about to save, and Hebrew counts in three
   * categories rather than English's two. `plurals.test.ts` calls `tFor('he')`
   * directly; this drives the same message through the screen that renders it,
   * so a `tr` that lost its ICU parser or a locale that stopped reaching
   * `parseLngForICU` fails here even though the JSON is untouched.
   */
  it('renders the Hebrew dual through the real button, and the singular next to it', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue({
      version: 'v1',
      proposalId: 'p-1',
      status: 'proposed',
      items: [
        { itemId: 'i-1', title: 'להגיש את הדוח', resolvedTime: '2026-09-14T15:00:00.000Z', needsClarification: false },
        { itemId: 'i-2', title: 'להתקשר לסמי', resolvedTime: null, needsClarification: false },
      ],
      provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
    } as never);

    await openAppIn('he');
    await fireEvent.press(screen.getByTestId('tab-capture'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'להגיש את הדוח מחר ולהתקשר לסמי');
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());

    // Two selected: Hebrew's `two` category, which is a different word from
    // the plural — «שתי התחייבויות», not «2 התחייבויות».
    expect(screen.getByTestId('review-confirm').props.accessibilityLabel).toBe('אישור שתי התחייבויות');

    await fireEvent.press(screen.getByTestId('review-check-i-2'));
    await waitFor(() =>
      expect(screen.getByTestId('review-confirm').props.accessibilityLabel).toBe('אישור התחייבות אחת'));
  });
});
