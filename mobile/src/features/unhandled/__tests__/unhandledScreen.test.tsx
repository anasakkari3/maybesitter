/**
 * «ما اتصرّفت فيها» on the phone (spec Part 1, design item 2, lane E2).
 *
 * What the screen must hold, each a case below:
 * - each item says what it is and when it ended or was due — never how late;
 * - the four answers each call what they claim to: done and «أسقطه بوعي» the
 *   commitment's own actions route, «لا تسألني عنها» the place's dismiss,
 *   and «تاريخ جديد» opens the ordinary postpone sheet;
 * - a press while one is on its way is not sent twice;
 * - an answer that lands after the item already left (409) is not an error;
 * - Today's entry is there only when the place holds something, and opens it;
 * - the copy exists in all three languages, with no "overdue" word.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from 'react-native';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import * as language from '../../../i18n/language';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import { ConflictError } from '../../../api/errors';
import { unhandledListSchema, type UnhandledItem } from '../../../api/schemas/commitments';
import fixture from '../../../api/__fixtures__/commitments.unhandled.json';
import { UnhandledEntry, UnhandledScreen, unhandledReasonLine } from '../UnhandledScreen';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'unhandled-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** The real route's response, as the exporter recorded it. */
const ITEMS: UnhandledItem[] = unhandledListSchema.parse(fixture).items;
const MEETING = ITEMS.find((item) => item.reason === 'event_ended')!;
const MEETING_ID = MEETING.commitment.id;

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(language, 'systemLanguageTag').mockReturnValue('en-US');
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
  jest.spyOn(commitmentEndpoints, 'listUnhandled').mockResolvedValue({ items: ITEMS });
  jest.spyOn(commitmentEndpoints, 'actOnCommitment').mockResolvedValue(
    { data: { success: true, id: MEETING_ID, commitment: MEETING.commitment }, etag: null } as never,
  );
  jest.spyOn(commitmentEndpoints, 'dismissUnhandled').mockResolvedValue({ success: true, id: MEETING_ID, dismissed: true });
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

function Probe() {
  const { s } = useApp();
  return <><Text testID="probe-screen">{s.screen}</Text><Text testID="probe-toast">{s.toast?.text ?? ''}</Text></>;
}

async function show(body: React.ReactNode, lang: 'en' | 'ar' | 'he' = 'en') {
  if (lang !== 'en') await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            {body}
            <Probe />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

function text(testID: string): string {
  return screen.getByTestId(testID).props.children as string;
}

describe('the «ما اتصرّفت فيها» screen', () => {
  it('lists each item with what it is and when, in the order the server gave', async () => {
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-${MEETING_ID}`)).not.toBeNull());
    for (const item of ITEMS) {
      expect(screen.getByTestId(`unhandled-title-${item.commitment.id}`)).toBeTruthy();
      expect(screen.getByTestId(`unhandled-reason-${item.commitment.id}`)).toBeTruthy();
    }
    expect(text('unhandled-lede')).toBe(en.unhandledLede);
  });

  it('says when it ended or was due, and never a lateness', () => {
    const now = new Date('2026-08-10T09:00:00.000Z');
    const ended = unhandledReasonLine({ reason: 'event_ended', since: '2026-08-09T09:00:00.000Z' }, en, 'en', 'Asia/Jerusalem', now);
    const due = unhandledReasonLine({ reason: 'deadline_passed', since: '2026-08-09T09:00:00.000Z' }, en, 'en', 'Asia/Jerusalem', now);
    expect(ended).toContain('Ended');
    expect(ended).toContain(en.yesterday);
    expect(due).toContain('Was due');
    expect(due).not.toEqual(ended);
  });

  it('done and «أسقطه بوعي» are the commitment’s own actions', async () => {
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-done-${MEETING_ID}`)).not.toBeNull());

    await fireEvent.press(screen.getByTestId(`unhandled-done-${MEETING_ID}`));
    await waitFor(() => expect(commitmentEndpoints.actOnCommitment).toHaveBeenCalledWith(MEETING_ID, 'complete', expect.anything()));
    await waitFor(() => expect(text('probe-toast')).toBe(en.toastDone));

    await fireEvent.press(screen.getByTestId(`unhandled-drop-${MEETING_ID}`));
    await waitFor(() => expect(commitmentEndpoints.actOnCommitment).toHaveBeenCalledWith(MEETING_ID, 'cancel', expect.anything()));
    expect(commitmentEndpoints.dismissUnhandled).not.toHaveBeenCalled();
  });

  it('«لا تسألني عنها» is the place’s dismiss, and changes no status', async () => {
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-dont-ask-${MEETING_ID}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`unhandled-dont-ask-${MEETING_ID}`));
    await waitFor(() => expect(commitmentEndpoints.dismissUnhandled).toHaveBeenCalledWith(MEETING_ID));
    expect(commitmentEndpoints.actOnCommitment).not.toHaveBeenCalled();
    await waitFor(() => expect(text('probe-toast')).toBe(en.toastUnhandledDismissed));
  });

  it('«تاريخ جديد» opens the ordinary postpone sheet and changes nothing by itself', async () => {
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-new-date-${MEETING_ID}`)).not.toBeNull());
    expect(screen.queryByTestId('postpone-sheet-close')).toBeNull();
    await fireEvent.press(screen.getByTestId(`unhandled-new-date-${MEETING_ID}`));
    await waitFor(() => expect(screen.queryByTestId('postpone-sheet-close')).not.toBeNull());
    expect(commitmentEndpoints.actOnCommitment).not.toHaveBeenCalled();
  });

  it('a second press while the first is on its way is not sent', async () => {
    let release: () => void = () => {};
    (commitmentEndpoints.dismissUnhandled as jest.Mock).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ success: true, id: MEETING_ID, dismissed: true }); }) as never,
    );
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-dont-ask-${MEETING_ID}`)).not.toBeNull());
    // Three taps inside one frame: nothing re-renders between them, so the
    // buttons are still enabled for all three and only the synchronous guard
    // can hold the second and the third.
    const dontAsk = screen.getByTestId(`unhandled-dont-ask-${MEETING_ID}`);
    const done = screen.getByTestId(`unhandled-done-${MEETING_ID}`);
    await act(async () => {
      void fireEvent.press(dontAsk);
      void fireEvent.press(dontAsk);
      void fireEvent.press(done);
    });
    release();
    await waitFor(() => expect(text('probe-toast')).toBe(en.toastUnhandledDismissed));
    expect(commitmentEndpoints.dismissUnhandled).toHaveBeenCalledTimes(1);
    expect(commitmentEndpoints.actOnCommitment).not.toHaveBeenCalled();
  });

  it('an answer that lands after the item already left is not an error', async () => {
    (commitmentEndpoints.dismissUnhandled as jest.Mock).mockRejectedValue(new ConflictError('not_unhandled') as never);
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-dont-ask-${MEETING_ID}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`unhandled-dont-ask-${MEETING_ID}`));
    await waitFor(() => expect(commitmentEndpoints.dismissUnhandled).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByTestId(`unhandled-failed-${MEETING_ID}`)).toBeNull();
  });

  it('a real failure says so and leaves the item where it was', async () => {
    (commitmentEndpoints.dismissUnhandled as jest.Mock).mockRejectedValue(new Error('network') as never);
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-dont-ask-${MEETING_ID}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`unhandled-dont-ask-${MEETING_ID}`));
    await waitFor(() => expect(screen.queryByTestId(`unhandled-failed-${MEETING_ID}`)).not.toBeNull());
    expect(screen.getByTestId(`unhandled-${MEETING_ID}`)).toBeTruthy();
  });

  it('every answer is a 44-point target whose label names the item it answers', async () => {
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-done-${MEETING_ID}`)).not.toBeNull());
    const labels: Record<string, string> = {
      done: en.done, 'new-date': en.unhandledNewDate, drop: en.dropIt, 'dont-ask': en.unhandledDontAsk,
    };
    for (const [key, label] of Object.entries(labels)) {
      const button = screen.getByTestId(`unhandled-${key}-${MEETING_ID}`);
      // A screen reader moving from button to button hears which item each one answers.
      expect(button.props.accessibilityLabel).toBe(`${label}: ${MEETING.commitment.title}`);
      expect(button.props.accessibilityRole).toBe('button');
      const style = [button.props.style].flat(Infinity).reduce((all: Record<string, unknown>, part) => ({ ...all, ...(part as object) }), {});
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it('a failed done refreshes the list, so an item gone on another device does not stay stuck', async () => {
    (commitmentEndpoints.actOnCommitment as jest.Mock).mockRejectedValue(new Error('gone') as never);
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-done-${MEETING_ID}`)).not.toBeNull());
    const before = (commitmentEndpoints.listUnhandled as jest.Mock).mock.calls.length;
    await fireEvent.press(screen.getByTestId(`unhandled-done-${MEETING_ID}`));
    await waitFor(() => expect((commitmentEndpoints.listUnhandled as jest.Mock).mock.calls.length).toBeGreaterThan(before));
  });

  it('a failed «أسقطه بوعي» refreshes the list too', async () => {
    (commitmentEndpoints.actOnCommitment as jest.Mock).mockRejectedValue(new Error('gone') as never);
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-drop-${MEETING_ID}`)).not.toBeNull());
    const before = (commitmentEndpoints.listUnhandled as jest.Mock).mock.calls.length;
    await fireEvent.press(screen.getByTestId(`unhandled-drop-${MEETING_ID}`));
    await waitFor(() => expect((commitmentEndpoints.listUnhandled as jest.Mock).mock.calls.length).toBeGreaterThan(before));
  });

  it('a 409 that is not shown as an error still refreshes the list', async () => {
    (commitmentEndpoints.actOnCommitment as jest.Mock).mockRejectedValue(new ConflictError('not_unhandled') as never);
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-done-${MEETING_ID}`)).not.toBeNull());
    const before = (commitmentEndpoints.listUnhandled as jest.Mock).mock.calls.length;
    await fireEvent.press(screen.getByTestId(`unhandled-done-${MEETING_ID}`));
    await waitFor(() => expect((commitmentEndpoints.listUnhandled as jest.Mock).mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByTestId(`unhandled-failed-${MEETING_ID}`)).toBeNull();
  });

  it('asks with the phone\u2019s own clock, so the list and Today answer the same question', async () => {
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(commitmentEndpoints.listUnhandled).toHaveBeenCalled());
    const [input] = (commitmentEndpoints.listUnhandled as jest.Mock).mock.calls[0] as [{ referenceTime?: string }];
    expect(typeof input?.referenceTime).toBe('string');
    expect(Number.isFinite(Date.parse(input.referenceTime as string))).toBe(true);
  });

  it('refreshes when the app comes back to the foreground', async () => {
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId(`unhandled-${MEETING_ID}`)).not.toBeNull());
    const before = (commitmentEndpoints.listUnhandled as jest.Mock).mock.calls.length;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect((commitmentEndpoints.listUnhandled as jest.Mock).mock.calls.length).toBeGreaterThan(before));
    focusManager.setFocused(undefined);
  });

  it('an empty place says so calmly', async () => {
    (commitmentEndpoints.listUnhandled as jest.Mock).mockResolvedValue({ items: [] } as never);
    await show(<UnhandledScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('unhandled-empty')).not.toBeNull());
  });
});

describe('Today’s entry into the place', () => {
  it('counts the items and opens the place', async () => {
    await show(<UnhandledEntry />);
    await waitFor(() => expect(screen.queryByTestId('today-unhandled')).not.toBeNull());
    expect(screen.getByTestId('today-unhandled').props.accessibilityLabel).toContain(`${ITEMS.length} things to look back on`);
    await fireEvent.press(screen.getByTestId('today-unhandled'));
    await waitFor(() => expect(text('probe-screen')).toBe('unhandled'));
  });

  it('is not drawn at all when the place is empty', async () => {
    (commitmentEndpoints.listUnhandled as jest.Mock).mockResolvedValue({ items: [] } as never);
    await show(<UnhandledEntry />);
    await waitFor(() => expect(commitmentEndpoints.listUnhandled).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByTestId('today-unhandled')).toBeNull();
  });

  it.each([['ar', ar], ['he', he]] as ['ar' | 'he', { unhandledTitle: string }][])('is said in %s, without pressure', async (lang, bundle) => {
    await show(<UnhandledEntry />, lang);
    await waitFor(() => expect(screen.queryByTestId('today-unhandled')).not.toBeNull());
    expect(bundle.unhandledTitle.length).toBeGreaterThan(0);
    expect(screen.getByTestId('today-unhandled').props.accessibilityLabel).not.toMatch(/[{}]/);
  });
});

describe('the copy', () => {
  const KEYS = [
    'unhandledEntry', 'unhandledTitle', 'unhandledLede', 'unhandledEventEnded', 'unhandledDeadlinePassed',
    'unhandledNewDate', 'unhandledDontAsk', 'unhandledEmpty', 'toastUnhandledDismissed',
  ] as const;

  const BUNDLES: [string, Record<string, unknown>][] = [['en', en], ['ar', ar], ['he', he]];
  it.each(BUNDLES)('%s has every string, and none says "overdue" or "late"', (_lang, bundle) => {
    for (const key of KEYS) {
      const value = bundle[key];
      expect(typeof value).toBe('string');
      expect(value).not.toMatch(/overdue|late\b|متأخر|تأخير|באיחור|מאחר/i);
    }
  });

  it('the Arabic answers are the product’s own words', () => {
    expect(ar.unhandledTitle).toBe('ما اتصرّفت فيها');
    expect(ar.unhandledDontAsk).toBe('لا تسألني عنها');
    expect(ar.done).toBe('تمّت');
    expect(ar.dropIt).toBe('أسقطه بوعي');
  });
});
