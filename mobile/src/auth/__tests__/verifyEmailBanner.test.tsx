import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Keyboard, StyleSheet, type KeyboardEvent } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../AuthProvider';
import {
  EXPANDED_SHARE,
  RESEND_COOLDOWN_SECONDS,
  TEXT_SHARE,
  VerifyEmailBanner,
  bannerTextLines,
} from '../VerifyEmailBanner';
import { createFakeAuthRepository, type FakeAuthRepository } from '../fakeAuthRepository';
import type { AuthUser } from '../types';
import en from '../../i18n/locales/en.json';
import { tFor } from '../../i18n';
import { Screen, ScreenScroll } from '../../ui/screen';
import { Btn, Txt } from '../../ui/primitives';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions')
  .default as jest.Mock;

/** The iOS accessibility sizes the UAT phone steps through (AX1 … AX5). */
const AX = [1.64, 1.94, 2.35, 2.76, 3.12];
/** One line of the banner's 13pt Arabic, before the reader's scale: round(13 × 1.6). */
const LINE = 21;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const UNVERIFIED: AuthUser = {
  uid: 'u1',
  email: 'someone@example.com',
  emailVerified: false,
  displayName: null,
  providerIds: ['password'],
};

async function renderBanner(repository: FakeAuthRepository, fontScale = 1, children?: React.ReactNode) {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <VerifyEmailBanner>{children}</VerifyEmailBanner>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

function ScreenUnderBanner() {
  const [count, setCount] = useState(0);
  const insets = useSafeAreaInsets();
  return (
    <Screen testID="screen-under-banner">
      <ScreenScroll testID="screen-under-banner-scroll">
        <Btn testID="screen-local-action" onPress={() => setCount(value => value + 1)}>
          <Txt testID="screen-local-state">{String(count)}</Txt>
        </Btn>
        <Txt testID="screen-device-insets">{`${insets.top}:${insets.bottom}`}</Txt>
      </ScreenScroll>
    </Screen>
  );
}

const screenTop = () => StyleSheet.flatten(screen.getByTestId('screen-under-banner').props.style).paddingTop;

/** Captures the keyboard listeners the banner adds, so a test can raise and drop it. */
function fakeKeyboard(visible = false) {
  const handlers: Record<string, ((event: KeyboardEvent) => void)[]> = {};
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(visible);
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, handler: (event: KeyboardEvent) => void) => {
    (handlers[name] ??= []).push(handler);
    return { remove: () => { handlers[name] = (handlers[name] ?? []).filter((h) => h !== handler); } };
  }) as never);
  const emit = async (name: string) => {
    await act(async () => {
      handlers[name]?.forEach((h) => h({ endCoordinates: { screenX: 0, screenY: 538, width: 390, height: 306 } } as KeyboardEvent));
    });
  };
  return { show: () => emit('keyboardWillShow'), hide: () => emit('keyboardWillHide') };
}

/** The banner's message, found by what a screen reader hears rather than by what is painted. */
const message = () => screen.getByLabelText(en.authVerifyBanner);

describe('email verification banner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useWindowDimensions.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('asks an unverified account to confirm, without blocking anything', async () => {
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }));
    expect(screen.getByText(en.authVerifyBanner)).toBeTruthy();
  });

  it('clears the status bar with the safe-area top inset', async () => {
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }));
    // The banner renders above every screen at the root, so the inset is its
    // own container's padding, not a screen's (#495).
    const banner = screen.getByText(en.authVerifyBanner).parent;
    expect(banner?.props.style).toMatchObject({ paddingTop: METRICS.insets.top + 12 });
  });

  it('stays out of the way once the address is verified', async () => {
    await renderBanner(createFakeAuthRepository({ initialUser: { ...UNVERIFIED, emailVerified: true } }));
    expect(screen.queryByText(en.authVerifyBanner)).toBeNull();
  });

  it('clears the status bar once for the banner and the screen beneath it', async () => {
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }), 1, <ScreenUnderBanner />);
    expect(StyleSheet.flatten(screen.getByTestId('verify-email-banner').props.style).paddingTop)
      .toBe(METRICS.insets.top + 12);
    expect(screenTop()).toBe(0);
    // Only the frame consumes this ownership signal; native modals still
    // receive the real top and bottom insets from SafeAreaProvider.
    expect(screen.getByTestId('screen-device-insets').props.children).toBe('47:34');
  });

  it('hands status-bar clearance back to the same screen after verification', async () => {
    const repository = createFakeAuthRepository({ initialUser: UNVERIFIED });
    await renderBanner(repository, 1, <ScreenUnderBanner />);
    await fireEvent.press(screen.getByTestId('screen-local-action'));
    await act(async () => repository.emit({ ...UNVERIFIED, emailVerified: true }));
    expect(screen.queryByTestId('verify-email-banner')).toBeNull();
    expect(screenTop()).toBe(METRICS.insets.top);
    expect(screen.getByTestId('screen-local-state').props.children).toBe('1');
  });

  it('never appears for a provider account with no address', async () => {
    await renderBanner(
      createFakeAuthRepository({
        initialUser: { ...UNVERIFIED, email: null, providerIds: ['apple.com'] },
      }),
    );
    expect(screen.queryByText(en.authVerifyBanner)).toBeNull();
  });

  it('resends once, then holds the button for the cooldown', async () => {
    const repository = createFakeAuthRepository({ initialUser: UNVERIFIED });
    await renderBanner(repository);
    await fireEvent.press(screen.getByLabelText(en.authVerifyResend));
    expect(repository.calls).toEqual([{ method: 'sendVerificationEmail' }]);

    // A second tap during the cooldown must not reach Firebase: it would only
    // trip the provider's own rate limit and lock the user out for longer.
    const cooling = screen.getByLabelText(tFor('en')('authVerifyCooldown', { s: RESEND_COOLDOWN_SECONDS }));
    await fireEvent.press(cooling);
    expect(repository.calls).toHaveLength(1);
  });

  it('counts the cooldown down and offers the button again', async () => {
    const repository = createFakeAuthRepository({ initialUser: UNVERIFIED });
    await renderBanner(repository);
    await fireEvent.press(screen.getByLabelText(en.authVerifyResend));
    // One second at a time: each tick schedules the next only after React has
    // committed, so a single 60 s jump would fire exactly one timer.
    for (let second = 0; second < RESEND_COOLDOWN_SECONDS; second += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
    }
    expect(screen.getByLabelText(en.authVerifyResend)).toBeTruthy();
  });
});

/*
 * UAT round 6, batch 9 (D-g remainder, app 520ea04a; shots 1079–1081).
 *
 * The banner is mounted once at the root, above every screen, as a row: the
 * sentence at `flex: 1` beside «ابعت من جديد», with no line cap. At the
 * accessibility sizes the pill took most of the row, the sentence wrapped a
 * few letters to a line, and the banner grew to 74–407pt at AX3, the whole
 * space above the keyboard at AX4 and 74–862pt at AX5 — the capture composer
 * below it was gone, «فهمها» behind the keyboard, and Today, Calendar and
 * Settings were swallowed the same way.
 */
describe('the banner takes a bounded share of the screen at every text size', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useWindowDimensions.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('caps nothing below the accessibility sizes', () => {
    for (const fontScale of [0.82, 1, 1.12, 1.24, 1.35, 1.5]) {
      expect(bannerTextLines({ windowHeight: 844, fontScale })).toBeUndefined();
    }
  });

  it('caps the sentence to the lines that fit its share of the window, never fewer than one', () => {
    for (const fontScale of AX) {
      for (const windowHeight of [844, 932, 667, 390]) {
        const lines = bannerTextLines({ windowHeight, fontScale });
        expect(lines).toBeGreaterThanOrEqual(1);
        // One line always shows; past one, the cap is the share.
        if ((lines ?? 0) > 1) expect((lines ?? 0) * LINE * fontScale).toBeLessThanOrEqual(windowHeight * TEXT_SHARE);
      }
    }
    // The UAT phone: two lines at AX1–AX3, one at AX4–AX5.
    expect(AX.map((fontScale) => bannerTextLines({ windowHeight: 844, fontScale }))).toEqual([2, 2, 2, 1, 1]);
  });

  it('keeps the default-size row exactly as the design draws it', async () => {
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }), 1);
    const text = screen.getByText(en.authVerifyBanner);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(text.parent?.props.style)).toMatchObject({ flexDirection: 'row', paddingTop: METRICS.insets.top + 12 });
    // The sentence is plain text there, not a toggle.
    expect(screen.queryByRole('button', { name: en.authVerifyBanner })).toBeNull();
  });

  it.each(AX)('at %p× stacks the button under a capped sentence, and says the whole of it', async (fontScale) => {
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }), fontScale);
    const lines = bannerTextLines({ windowHeight: 844, fontScale });
    const text = screen.getByText(en.authVerifyBanner);
    expect(text.props.numberOfLines).toBe(lines);
    // A screen reader hears the full sentence, whatever is painted.
    expect(message().props.accessibilityState).toMatchObject({ expanded: false });
    // «ابعت من جديد» is still there, full width under the sentence.
    expect(screen.getByLabelText(en.authVerifyResend)).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('verify-email-banner').props.style)).toMatchObject({
      flexDirection: 'column',
      paddingTop: METRICS.insets.top + 12,
    });
  });

  it('shows the whole sentence on a tap, in a region capped at its share, and folds it back', async () => {
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }), 3.12);
    await fireEvent.press(message());
    expect(screen.getByText(en.authVerifyBanner).props.numberOfLines).toBeUndefined();
    expect(message().props.accessibilityState).toMatchObject({ expanded: true });
    const region = screen.getByTestId('verify-email-banner-full');
    expect(StyleSheet.flatten(region.props.style).maxHeight).toBeLessThanOrEqual(Math.round(844 * EXPANDED_SHARE));
    await fireEvent.press(message());
    expect(screen.getByText(en.authVerifyBanner).props.numberOfLines).toBe(1);
  });

  it('caps the "sent" confirmation the same way', async () => {
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }), 3.12);
    await fireEvent.press(screen.getByLabelText(en.authVerifyResend));
    expect(screen.getByText(en.authVerifyResent).props.numberOfLines).toBe(1);
    expect(screen.getByLabelText(en.authVerifyResent)).toBeTruthy();
  });
});

describe('the banner steps aside while the reader types', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useWindowDimensions.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([1, 3.12])('at %p× it is gone while the keyboard is up and back when it goes down', async (fontScale) => {
    const keyboard = fakeKeyboard();
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }), fontScale);
    expect(screen.getByText(en.authVerifyBanner)).toBeTruthy();
    await keyboard.show();
    expect(screen.queryByText(en.authVerifyBanner)).toBeNull();
    expect(screen.queryByTestId('verify-email-banner')).toBeNull();
    await keyboard.hide();
    expect(screen.getByText(en.authVerifyBanner)).toBeTruthy();
    expect(screen.getByLabelText(en.authVerifyResend)).toBeTruthy();
  });

  it('does not draw itself over a keyboard that was already up', async () => {
    fakeKeyboard(true);
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }), 3.12);
    expect(screen.queryByTestId('verify-email-banner')).toBeNull();
  });

  it('hands clearance back while typing without remounting the screen', async () => {
    const keyboard = fakeKeyboard();
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }), 1, <ScreenUnderBanner />);
    await fireEvent.press(screen.getByTestId('screen-local-action'));
    expect(screenTop()).toBe(0);
    await keyboard.show();
    expect(screenTop()).toBe(METRICS.insets.top);
    expect(screen.getByTestId('screen-local-state').props.children).toBe('1');
    await keyboard.hide();
    expect(screenTop()).toBe(0);
    expect(screen.getByTestId('screen-local-state').props.children).toBe('1');
  });

  it('keeps the resend cooldown across the keyboard coming and going', async () => {
    const keyboard = fakeKeyboard();
    const repository = createFakeAuthRepository({ initialUser: UNVERIFIED });
    await renderBanner(repository);
    await fireEvent.press(screen.getByLabelText(en.authVerifyResend));
    await keyboard.show();
    await keyboard.hide();
    await fireEvent.press(screen.getByLabelText(tFor('en')('authVerifyCooldown', { s: RESEND_COOLDOWN_SECONDS })));
    expect(repository.calls).toHaveLength(1);
  });
});
