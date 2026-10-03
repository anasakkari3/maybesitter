/**
 * «احكيها», the production black-box audit of 2026-10-03 — the phone's half.
 *
 *   #6  a card the server says counts toward one of the person's goals shows
 *       «مرتبط بهدف …»; it is kept unless the person removes it, and the
 *       confirm links only what was kept. A review that never draws the chip
 *       (no conversation) links nothing.
 *   #1  after a save, the confirm's clash warnings are one message, not one
 *       per pair: three items at one hour came back as six lines.
 *   #8  a new proposal scrolls its confirm into view above the composer, and
 *       a save does not focus the empty composer (its keyboard hid the line
 *       saying what was saved).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ScrollView } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { captureConfirmationSchema, type CaptureProposal } from '../../../api/schemas/capture';
import { chatServer } from '../../../testing/captureChat';
import { stripIsolates } from '../../../i18n/bidi';
import { captureReducer, confirmPayload, initialCaptureState, type CaptureState } from '../captureMachine';
import { collisionLines } from '../savedCollisions';
import { chatConflictLines } from '../chatConflicts';
import { SayItChatPage, type SayItChatPageProps } from '../SayItChatPage';
import type { Strings } from '../../../i18n/strings';

// The real page, with its props recorded: what the screen asks of it after a save.
jest.mock('../SayItChatPage', () => {
  const actual = jest.requireActual<typeof import('../SayItChatPage')>('../SayItChatPage');
  return { ...actual, SayItChatPage: jest.fn((props: SayItChatPageProps) => actual.SayItChatPage(props)) };
});
const pageProps = () => (SayItChatPage as unknown as jest.Mock<(props: SayItChatPageProps) => unknown>).mock.calls.map(([props]) => props);

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = { uid: 'goal-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const TUESDAY = at(30);
const THURSDAY = at(78);
const GOAL = { goalId: 'mem_goal-1', title: 'Learn React' };

/** The server's answer to the audit's second message, as it is now: two sessions, each offering the goal. */
function sessions(): CaptureProposal {
  return {
    version: 'v1', proposalId: 'p-react', status: 'proposed',
    seeds: [],
    items: [
      { itemId: 'tue', title: 'Study', resolvedTime: TUESDAY, needsClarification: false, goalLink: GOAL },
      { itemId: 'thu', title: 'Study', resolvedTime: THURSDAY, needsClarification: false, goalLink: GOAL },
    ],
  };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
});

afterEach(async () => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

async function openCapture() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
}

async function say(text: string) {
  await fireEvent.changeText(screen.getByTestId('capture-input'), text);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
}

const textOf = (testID: string): string => {
  const children = screen.getByTestId(testID).props.children as unknown;
  return stripIsolates(Array.isArray(children) ? children.join('') : String(children));
};

function answering(proposal: CaptureProposal) {
  return jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(
    () => proposal,
    { reply: () => 'Study on Tuesday and Thursday at 7 PM. Confirm below.', engine: 'model' },
  ) as never);
}

describe('audit #6: «مرتبط بهدف …» on the card, kept or removed, linked only when kept', () => {
  it('shows the goal on each card, and the confirm links only the cards it was left on', async () => {
    answering(sessions());
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(captureConfirmationSchema.parse({
      success: true, replayed: false, failed: [], collisions: [],
      persisted: [
        { itemId: 'tue', commitmentId: 'c-tue', title: 'Study', resolvedTime: TUESDAY },
        { itemId: 'thu', commitmentId: 'c-thu', title: 'Study', resolvedTime: THURSDAY },
      ],
      goalLinks: [{ itemId: 'thu', goalId: GOAL.goalId, commitmentId: 'c-thu' }],
    }) as never);
    await openCapture();
    await say('Every Tuesday and Thursday at 7 PM');
    await waitFor(() => expect(screen.queryByTestId('review-goal-tue')).not.toBeNull());

    const linkedLine = en.reviewGoalLink.replace('{goal}', 'Learn React');
    expect(textOf('review-goal-tue-text')).toBe(linkedLine);
    expect(textOf('review-goal-thu-text')).toBe(linkedLine);
    // One control with its state, named by what it says.
    const toggle = screen.getByTestId('review-goal-tue');
    expect(toggle.props.accessibilityRole).toBe('checkbox');
    expect(toggle.props.accessibilityState).toMatchObject({ checked: true });

    // Removed on Tuesday: the card says so, and offers it back.
    await fireEvent.press(toggle);
    expect(textOf('review-goal-tue-text')).toBe(en.reviewGoalLinkRemoved.replace('{goal}', 'Learn React'));
    expect(textOf('review-goal-tue-action')).toBe(en.reviewGoalLinkRestore);
    expect(screen.getByTestId('review-goal-tue').props.accessibilityState).toMatchObject({ checked: false });

    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]![0]).toMatchObject({ proposalId: 'p-react', itemIds: ['tue', 'thu'], goalLinkItemIds: ['thu'] });
    // The saved line says what it counts toward.
    await waitFor(() => expect(screen.queryByTestId('chat-saved-1')).not.toBeNull());
    expect(stripIsolates(screen.getByTestId('chat-saved-1').props.accessibilityLabel as string))
      .toContain(en.chatSavedGoal.replace('{goals}', '"Learn React"'));
  });

  it('a confirm with every link removed sends no goalLinkItemIds at all', async () => {
    answering(sessions());
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({
      success: true, replayed: false, failed: [], persisted: [{ itemId: 'tue', commitmentId: 'c-tue', title: 'Study', resolvedTime: TUESDAY }],
    } as never);
    await openCapture();
    await say('Every Tuesday and Thursday at 7 PM');
    await waitFor(() => expect(screen.queryByTestId('review-goal-tue')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('review-goal-tue'));
    await fireEvent.press(screen.getByTestId('review-goal-thu'));
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]![0]).not.toHaveProperty('goalLinkItemIds');
  });

  it('a review with no conversation (a share, a meeting prep) never links: the chip was never drawn there', () => {
    let state: CaptureState = captureReducer(initialCaptureState(), { type: 'analyzeSucceeded', proposal: sessions() });
    expect(confirmPayload(state).goalLinkItemIds).toBeUndefined();
    // In a conversation, kept by default; removed, not sent.
    state = { ...state, conversationId: 'conv-1' };
    expect(confirmPayload(state).goalLinkItemIds).toEqual(['tue', 'thu']);
    state = captureReducer(state, { type: 'setGoalLink', itemId: 'tue', linked: false });
    expect(confirmPayload(state).goalLinkItemIds).toEqual(['thu']);
    state = captureReducer(state, { type: 'setGoalLink', itemId: 'tue', linked: true });
    expect(confirmPayload(state).goalLinkItemIds).toEqual(['tue', 'thu']);
  });
});

describe('audit #1: the warnings after a save are one message', () => {
  const when = (startsAt: string) => startsAt.slice(11, 16);
  const pairs = [
    { commitmentId: 'b', title: 'Study', startsAt: TUESDAY, endsAt: TUESDAY },
    { commitmentId: 'c', title: 'Study', startsAt: TUESDAY, endsAt: TUESDAY },
    { commitmentId: 'a', title: 'Learn React', startsAt: TUESDAY, endsAt: TUESDAY },
    { commitmentId: 'c', title: 'Study', startsAt: TUESDAY, endsAt: TUESDAY },
    { commitmentId: 'a', title: 'Learn React', startsAt: TUESDAY, endsAt: TUESDAY },
    { commitmentId: 'b', title: 'Study', startsAt: TUESDAY, endsAt: TUESDAY },
  ];

  it('six per-pair warnings for three items are one line naming each once; one clash is the line it always was', () => {
    for (const [lang, strings] of [['en', en], ['ar', ar]] as const) {
      const lines = collisionLines(pairs, strings as unknown as Strings, lang, when);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain((strings.savedCollisionMany as string).split('{list}')[0]!);
      expect(stripIsolates(lines[0]!).match(/Learn React/g)).toHaveLength(1);
    }
    const one = collisionLines([pairs[0]!, pairs[0]!], en as unknown as Strings, 'en', when);
    expect(one).toEqual([en.savedCollision.replace('{title}', 'Study').replace('{when}', when(TUESDAY))]);
    expect(collisionLines([], en as unknown as Strings, 'en', when)).toEqual([]);
  });

  it('in the chat, the saved line carries one clash paragraph, and the composer is not focused after the save', async () => {
    answering(sessions());
    jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({
      success: true, replayed: false, failed: [], collisions: pairs,
      persisted: [{ itemId: 'tue', commitmentId: 'c-tue', title: 'Study', resolvedTime: TUESDAY }],
    } as never);
    await openCapture();
    await say('Every Tuesday and Thursday at 7 PM');
    await waitFor(() => expect(screen.queryByTestId('review-confirm')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(screen.queryByTestId('chat-saved-1')).not.toBeNull());
    const said = stripIsolates(screen.getByTestId('chat-saved-1').props.accessibilityLabel as string);
    expect(said.split(en.savedCollisionMany.split('{list}')[0]!)).toHaveLength(2);
    expect(said).not.toContain(en.savedCollision.split('{title}')[0]!);
    // No refocus: the page is never asked to focus the field after the save.
    const after = pageProps();
    expect(after.length).toBeGreaterThan(0);
    for (const props of after) expect(props.composerFocusKey ?? 0).toBe(0);
  });
});

describe('audit #1: a clash with another card of the same list says so, before the save', () => {
  it('names the other card as one on this list; a saved commitment keeps its own line', () => {
    const item = (inProposal?: boolean) => ({
      resolvedTime: TUESDAY,
      conflicts: [{ title: 'Call with Sara', startsAt: TUESDAY, endsAt: TUESDAY, kind: 'commitment' as const, ...(inProposal ? { inProposal } : {}) }],
    });
    const options = { lang: 'en' as const, timezone: 'UTC', t: en as unknown as Strings, busyChipShown: false };
    const [inList] = chatConflictLines(item(true), undefined, options);
    const [saved] = chatConflictLines(item(), undefined, options);
    expect(stripIsolates(inList!)).toContain(en.chatConflictInList.split('{when}')[0]!.replace('{title}', 'Call with Sara'));
    expect(stripIsolates(saved!)).toContain(en.chatConflictWith.split('{when}')[0]!.replace('{title}', 'Call with Sara'));
    expect(inList).not.toBe(saved);
  });
});

describe('audit #8: a new proposal brings its confirm into view', () => {
  const baseProps: SayItChatPageProps = {
    colors: {
      bg: '#17191b', sf: '#222426', sf2: '#282a2d', tx: '#f7f5f5', mu: '#b5b3ba',
      ln: '#303236', lnStrong: '#424448', ac: '#fd7b94', acd: '#ff93a8', acs: '#6d3745',
      onAccent: '#17191b', dis: '#343538', disTx: '#b5b3ba', success: '#2ed889',
    },
    fonts: { regular: 'Outfit-Regular', semibold: 'Outfit-SemiBold', lineRatio: 1.3 },
    copy: {
      title: 'Say it', subtitle: 'Here', placeholder: 'Just say it…', closeLabel: 'Back', moreLabel: 'More', pasteLabel: 'Paste',
      sendLabel: 'Send', confirmLabel: 'Save 1', editLabel: 'Change', includeLabel: 'Save this',
    },
    text: '', canSend: false,
    onChangeText: () => {}, onSend: () => {}, onClose: () => {}, onMore: () => {}, onPaste: () => {},
    scheduleGroups: [{ id: 'd', title: 'Tuesday', rows: [{ id: 'r', title: 'Study', subtitle: '19:00', selected: true }] }],
    onConfirm: () => {}, canConfirm: true,
  };
  const layout = (y: number, height: number) => ({ nativeEvent: { layout: { x: 0, y, width: 390, height } } });

  /** One proposal laid out: the window, the schedule block, its card, and the confirm inside it. */
  const lay = async (viewport: number, blockY: number, confirmY: number) => {
    await fireEvent(screen.getByTestId('review-scroll'), 'layout', layout(0, viewport));
    await fireEvent(screen.getByTestId('chat-schedule'), 'layout', layout(blockY, 400));
    await fireEvent(screen.getByTestId('chat-schedule-card'), 'layout', layout(0, 380));
    await fireEvent(screen.getByTestId('chat-add-schedule'), 'layout', layout(confirmY, 52));
  };

  it('scrolls once per proposal so the confirm sits above the composer, never past it', async () => {
    const scrollTo = jest.spyOn(ScrollView.prototype as unknown as { scrollTo: (...args: unknown[]) => void }, 'scrollTo').mockImplementation(() => {});
    scrollTo.mockClear();
    await render(<SayItChatPage {...baseProps} revealConfirmKey="p-1" />);
    await lay(500, 640, 300);
    // 640 + 300 + 52 + 16 − 500: the confirm's bottom at the window's bottom.
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 508, animated: true });
    const calls = scrollTo.mock.calls.length;
    // The same proposal laid out again does not pull the person back down.
    await fireEvent(screen.getByTestId('review-scroll'), 'layout', layout(0, 480));
    expect(scrollTo.mock.calls.length).toBe(calls);
  });

  it('a new proposal waits for its own layout: a list that grew from one card to three is scrolled to its new confirm', async () => {
    const scrollTo = jest.spyOn(ScrollView.prototype as unknown as { scrollTo: (...args: unknown[]) => void }, 'scrollTo').mockImplementation(() => {});
    scrollTo.mockClear();
    const view = await render(<SayItChatPage {...baseProps} revealConfirmKey="p-1" />);
    await lay(500, 640, 300);
    scrollTo.mockClear();
    // The next proposal arrives: nothing is scrolled on the last one's numbers.
    await view.rerender(<SayItChatPage {...baseProps} revealConfirmKey="p-2" reduceMotion />);
    expect(scrollTo.mock.calls).toEqual([]);
    // Its own layout — three cards, the confirm 500 points lower — decides, and under reduce motion it jumps.
    await lay(500, 640, 800);
    expect(scrollTo.mock.calls).toEqual([[{ y: 1008, animated: false }]]);
  });

  it('does not scroll when the confirm is already in view', async () => {
    const scrollTo = jest.spyOn(ScrollView.prototype as unknown as { scrollTo: (...args: unknown[]) => void }, 'scrollTo').mockImplementation(() => {});
    scrollTo.mockClear();
    await render(<SayItChatPage {...baseProps} revealConfirmKey="p-1" />);
    await lay(800, 100, 200);
    expect(scrollTo.mock.calls).toEqual([]);
  });
});
