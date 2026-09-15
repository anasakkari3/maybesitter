/**
 * "Nothing was saved", in Arabic, on the screen (#166, #338).
 *
 * ── What was missing ─────────────────────────────────────────────
 *
 * Three things already exist and none of them is this. `noCommitmentCopy.test.ts`
 * reads the three JSON files and holds the words to #166's rules — it renders
 * nothing. `captureFlowReachable.test.tsx` renders the branch, in English
 * only, for two of the six reasons. `hebrewUi.test.tsx` renders it in Hebrew,
 * for one reason, because Hebrew was the language that had just been made
 * reachable.
 *
 * Arabic is the default language of this product and the branch had no
 * rendered Arabic coverage at all — which is precisely the failure #166's own
 * copy test warns about and cannot catch: the line existing in `ar.json` and
 * never reaching a screen. Hebrew shipped one type away from working for
 * exactly this reason, and three test files said so in their comments while it
 * did.
 *
 * ── Why it enumerates the reasons instead of picking one ─────────
 *
 * `NO_COMMITMENT_REASONS` is the list this build can say. Driving all six
 * means a seventh reason added to the mapping without Arabic copy fails here,
 * rather than shipping as the generic line to an Arabic reader while the
 * English one is correct.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
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
import { NO_COMMITMENT_REASONS } from '../noCommitment';

import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';

// Hoisted above the imports so `src/i18n/timezone` sees it. The zone is not
// what this file is about; it is pinned to somewhere no host is set to so that
// nothing here can pass by agreeing with the machine it runs on.
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Pacific/Marquesas' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar-JO', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'nothing-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** What the person wrote. It must not come back at them under a heading. */
const TYPED = 'مرحبا، كيفك اليوم';

const ARABIC_LINE: Record<string, string> = {
  informational: ar.noCommitmentInformational,
  greeting_or_chat: ar.noCommitmentGreetingOrChat,
  question: ar.noCommitmentQuestion,
  past_event: ar.noCommitmentPastEvent,
  negated_request: ar.noCommitmentNegatedRequest,
  low_confidence: ar.noCommitmentLowConfidence,
};
const ENGLISH_LINE: Record<string, string> = {
  informational: en.noCommitmentInformational,
  greeting_or_chat: en.noCommitmentGreetingOrChat,
  question: en.noCommitmentQuestion,
  past_event: en.noCommitmentPastEvent,
  negated_request: en.noCommitmentNegatedRequest,
  low_confidence: en.noCommitmentLowConfidence,
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function nothing(reason: string | undefined) {
  return {
    version: 'v1',
    proposalId: 'p-1',
    status: 'no_commitment',
    ...(reason === undefined ? {} : { noCommitmentReason: reason }),
    items: [],
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
function styleOf(node: { props: Record<string, unknown> }, key: string): unknown {
  return [node.props.style].flat(4)
    .map(style => (style && typeof style === 'object' ? (style as Record<string, unknown>)[key] : undefined))
    .find(value => value !== undefined);
}

/**
 * Open the app in Arabic, type, analyse, and land on the "nothing" screen.
 *
 * Every `render`/`fireEvent` is awaited: RNTL v14's `render` is async, and an
 * un-awaited one leaves the *next* test mounting nothing and passing against
 * an empty tree.
 */
async function analyseInto(reason: string | undefined) {
  jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(nothing(reason) as never);
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
  await fireEvent.changeText(screen.getByTestId('capture-input'), TYPED);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('capture-nothing')).not.toBeNull());
  return view;
}

describe('nothing was saved, said in Arabic (#166)', () => {
  it.each(NO_COMMITMENT_REASONS)('shows the Arabic line for %s and no English beside it', async reason => {
    await analyseInto(reason);

    expect(screen.getByTestId('capture-nothing-reason').props.children).toBe(ARABIC_LINE[reason]);
    expect(screen.queryByText(ENGLISH_LINE[reason] as string)).toBeNull();
    // The heading is the app's too, not the server's, and not English.
    expect(screen.queryByText(ar.nothingTitle)).not.toBeNull();
    expect(screen.queryByText(en.nothingTitle)).toBeNull();
  });

  it('falls back to the Arabic neutral line for a reason this build cannot read', async () => {
    // A newer server sending a seventh code must not produce a blank screen or
    // an English one. The user pressed a button and is owed an answer in their
    // own language.
    await analyseInto(undefined);
    expect(screen.getByTestId('capture-nothing-reason').props.children).toBe(ar.noCommitmentInformational);
  });

  it('reads right to left, in the Arabic face, and quotes nothing back', async () => {
    const view = await analyseInto('greeting_or_chat');
    const line = screen.getByTestId('capture-nothing-reason');

    expect(renderedDirection(view.toJSON())).toBe('rtl');
    // Outfit has no Arabic glyphs at all, so the wrong face here is a screen
    // of tofu that no assertion on the string alone would notice.
    expect(styleOf(line, 'fontFamily')).toBe('NotoNaskhArabic_400Regular');
    expect(styleOf(line, 'writingDirection')).toBe('rtl');

    // #166's other rule, in the language it is being read in: repeating what
    // somebody wrote under a heading is a response to the person rather than
    // to their request.
    expect(screen.queryByText(new RegExp(TYPED))).toBeNull();
    // And the two ways out are offered — an answer with no exit is not one.
    expect(screen.queryByTestId('capture-nothing-close')).not.toBeNull();
    expect(screen.queryByTestId('capture-nothing-rephrase')).not.toBeNull();
  });
});
