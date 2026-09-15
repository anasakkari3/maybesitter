/**
 * The edit sheet, read right to left (#164, #338).
 *
 * ── What was missing ─────────────────────────────────────────────
 *
 * `editProposalItemSheet.test.tsx` drives the whole sheet and asserts nothing
 * about direction: it mocks the device into English and stays there. So every
 * claim `mobile/AGENTS.md` makes about this screen — the field is aligned to
 * the reading direction, a Latin-digit clock inside an Arabic line is isolated
 * and set in the Latin face, the refusals are in the user's own words — held
 * only in the source. Arabic is the default language of this product; the
 * sheet had no Arabic coverage at all.
 *
 * ── Why the zone is Pacific/Marquesas ────────────────────────────
 *
 * A timezone test elsewhere in this repository passed against a deliberately
 * broken conversion because the mocked zone happened to match the host's. This
 * project is developed and run at UTC+02:00/+03:00, so a mock of Asia/Jerusalem
 * proves nothing here. Marquesas is UTC−09:30 all year: no host is set to it,
 * the offset is not a whole number of hours, and a rendered time that dropped
 * `timeZone` and fell back to the host cannot coincidentally agree with the
 * expected one.
 *
 * ── Why no instant is written down ───────────────────────────────
 *
 * A literal instant in a fixture flowed into this sheet's past-time guard once
 * already and turned mobile CI red the day the wall clock walked past it
 * (#382). Every time here is derived from `Date.now()` at load, and the
 * expected wall clock is derived from the same instant through `Intl` directly
 * — not through the app's formatter, so a formatter that lost the zone, the
 * 24-hour cycle or the Latin digits fails instead of agreeing with itself.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';

import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';

/** UTC−09:30, no DST, and nobody's laptop. See the header. */
const ZONE = 'Pacific/Marquesas';

// Hoisted above the imports so `src/i18n/timezone` sees it when it reaches for
// `getCalendars`. The device is Arabic here as well as the stored preference,
// so neither door alone is what puts the app into Arabic.
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Pacific/Marquesas' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar-JO', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'rtl-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** Far enough ahead that the sheet's past-time guard is not in play. */
const SOON = new Date(Date.now() + 30 * 3_600_000).toISOString();

/** The wall clock `SOON` is in Marquesas, built straight from `Intl`. */
const SOON_WALL_CLOCK = new Intl.DateTimeFormat('en', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ZONE,
}).format(new Date(SOON));

// U+2066 / U+2069. A time in Latin digits dropped into an Arabic line drags the
// punctuation around it to the wrong side without them.
const LRI = '⁦';
const PDI = '⁩';

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function proposal() {
  return {
    version: 'v1',
    proposalId: 'p-1',
    status: 'proposed',
    items: [
      {
        itemId: 'i-1',
        title: 'تسليم التقرير',
        resolvedTime: SOON,
        needsClarification: false,
        priority: 'normal',
        priorityEstimated: true,
      },
    ],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
  };
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
  jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
  jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({
    success: true, replayed: false, persisted: [], failed: [],
  } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

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

/** One style property off a rendered node, whatever shape its `style` is in. */
function styleOf<K extends string>(node: { props: Record<string, unknown> }, key: K): unknown {
  return [node.props.style].flat(4)
    .map(style => (style && typeof style === 'object' ? (style as Record<string, unknown>)[key] : undefined))
    .find(value => value !== undefined);
}

/**
 * Open the app in Arabic, propose, and open the sheet on the one item.
 *
 * Every `render`/`fireEvent` is awaited: RNTL v14's `render` is async, and an
 * un-awaited one leaves the *next* test mounting nothing and passing against
 * an empty tree.
 */
async function openSheet() {
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  // The stored preference is read in an effect, so the first frame is still
  // the fallback language. Reading the screen before this is reading English.
  await waitFor(() => expect(screen.queryByText(ar.tabToday)).not.toBeNull());
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('capture-input'), 'ذكّرني أسلّم التقرير');
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('review-edit-i-1'));
  await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull());
  return view;
}

describe('the edit sheet in Arabic', () => {
  it('opens inside a right-to-left app and says nothing in English', async () => {
    const view = await openSheet();

    // Direction is set once, on the root view, and everything below mirrors
    // from it. A sheet that rendered outside that subtree would read LTR.
    expect(renderedDirection(view.toJSON())).toBe('rtl');

    expect(screen.queryByText(ar.editItemTitle)).not.toBeNull();
    expect(screen.queryByText(en.editItemTitle)).toBeNull();
    // The three levels are the user's words too, and the ids are not enough:
    // a button can carry the right id and the wrong label.
    expect(screen.getByTestId('edit-item-priority-high').props.accessibilityLabel).toBe(ar.todayGroupMust);
    expect(screen.queryByText(en.todayGroupMust)).toBeNull();
  });

  it('aligns the title field to the side Arabic is read from, in the Arabic face', async () => {
    await openSheet();
    const field = screen.getByTestId('edit-item-title');

    // `textAlign` is the one thing `direction: 'rtl'` on the root does not do
    // for a TextInput: the caret and the placeholder sit on the physical left
    // unless the field is told otherwise, which is an Arabic sentence typed
    // from the wrong edge of the box.
    expect(styleOf(field, 'textAlign')).toBe('right');
    // Outfit has no Arabic glyphs, so the wrong face here is a field of tofu.
    expect(styleOf(field, 'fontFamily')).toBe('NotoNaskhArabic_400Regular');
  });

  it('keeps the clock left to right, in Latin digits, in the Latin face', async () => {
    await openSheet();

    const time = within(screen.getByTestId('edit-item-pick-time')).getByText(/\d/);
    const rendered = String(time.props.children);

    // 1. Isolated. Without U+2066…U+2069 the colon and the digits reorder
    //    against the Arabic around them and 09:30 can render as 30:09.
    expect(rendered.startsWith(LRI)).toBe(true);
    expect(rendered.endsWith(PDI)).toBe(true);

    // 2. The right instant in the right zone, on a 24-hour clock. Dropping
    //    `hourCycle: 'h23'` renders «08:20 ص» and fails the pattern; dropping
    //    `timeZone` renders the host's hour and fails the comparison, which is
    //    what the −09:30 zone is for.
    //
    //    What this *cannot* check is the other half of `ar-u-nu-latn`. Node's
    //    ICU already resolves plain `ar` to `latn` numbering, so an Arabic
    //    build that lost the extension renders the same digits here and this
    //    would pass — a rendered assertion that agrees with the host by
    //    coincidence. `src/i18n/__tests__/locale.test.ts` is the one that goes
    //    red for it, and it does; claiming it here as well would be the kind of
    //    assertion that cannot fail.
    const bare = rendered.slice(LRI.length, -PDI.length);
    expect(bare).toMatch(/^\d{2}:\d{2}$/);
    expect(bare).toBe(SOON_WALL_CLOCK);

    // 3. Set in Outfit even though the app is Arabic: `Txt latin` exists
    //    because Noto Naskh's tall line box clips digits in a tight box.
    expect(styleOf(time, 'fontFamily')).toBe('Outfit_400Regular');

    // And the button beside it is not Latin — it is a date in Arabic, so it
    // keeps the Arabic face. Both being Outfit would mean `latin` had leaked.
    const date = within(screen.getByTestId('edit-item-pick-date')).getByText(/./);
    expect(styleOf(date, 'fontFamily')).toBe('NotoNaskhArabic_400Regular');
    expect(String(date.props.children)).toMatch(/[؀-ۿ]/);
  });

  it('refuses an empty title in Arabic, not in the fallback language', async () => {
    await openSheet();
    await fireEvent.changeText(screen.getByTestId('edit-item-title'), '   ');
    await waitFor(() => expect(screen.queryByTestId('edit-item-problem')).not.toBeNull());

    expect(screen.getByTestId('edit-item-problem').props.children).toBe(ar.editItemEmpty);
    expect(screen.queryByText(en.editItemEmpty)).toBeNull();
    expect(screen.getByTestId('edit-item-save').props.accessibilityState.disabled).toBe(true);
  });

  it('carries an Arabic title through to the card unchanged', async () => {
    // Not a direction claim but the one that would hurt most: an app that
    // mangled the user's own script on the way back out. The card is what they
    // read before pressing Confirm.
    await openSheet();
    await fireEvent.changeText(screen.getByTestId('edit-item-title'), 'سلّم التقرير النهائي');
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).toBeNull());

    expect(screen.queryByText(/سلّم التقرير النهائي/)).not.toBeNull();
    // And still nothing has been written: the notice is up until Confirm.
    expect(screen.queryByText(ar.suggestionNote)).not.toBeNull();
  });
});
