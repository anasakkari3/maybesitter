import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Platform, StyleSheet } from 'react-native';
import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { CaptureProvider } from '../../features/capture/CaptureProvider';
import { OnboardingChrome } from '../../features/onboarding/OnboardingChrome';
import { ReviewScreen } from '../ReviewScreen';
import { TodayScreen } from '../TodayScreen';
import { CalendarScreen } from '../CalendarScreen';
import { Txt } from '../../ui/primitives';
import { FLOATING_GAP, TAB_CLEARANCE } from '../../ui/screen';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function flat(style: unknown): Record<string, unknown> {
  return StyleSheet.flatten(style) as Record<string, unknown>;
}

async function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <AppProvider>
            <CaptureProvider>
              {ui}
            </CaptureProvider>
          </AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

describe('Mobile Pre-Launch UI Reality Audit Regressions', () => {
  describe('Keyboard Avoidance', () => {
    // The shared container replaced RN's KeyboardAvoidingView (UAT 2026-09-26,
    // #6): that one under-padded by whatever chrome sat above it. See
    // src/ui/__tests__/keyboard.test.tsx for the census.
    it('OnboardingChrome wraps screen content in the shared keyboard-avoiding container', async () => {
      const src = readFileSync(join(__dirname, '../../features/onboarding/OnboardingChrome.tsx'), 'utf8');
      expect(src).toMatch(/<AvoidKeyboard\b/);

      await wrap(
        <OnboardingChrome
          step="welcome"
          title="Test Title"
          primary={{ label: 'Next', onPress: () => {} }}
        >
          <Txt>Onboarding Content</Txt>
        </OnboardingChrome>,
      );

      const kav = screen.getByTestId('onboarding-kav');
      expect(kav).toBeTruthy();
      expect(flat(kav.props.style).flex).toBe(1);
    });

    it('ReviewScreen wraps body in the shared keyboard-avoiding container', async () => {
      const src = readFileSync(join(__dirname, '../ReviewScreen.tsx'), 'utf8');
      expect(src).toMatch(/<AvoidKeyboard\b/);

      await wrap(<ReviewScreen />);
      const kav = screen.getByTestId('review-kav');
      expect(kav).toBeTruthy();
      expect(flat(kav.props.style).flex).toBe(1);
    });
  });

  describe('Tab Clearance propagation on root tab screens', () => {
    // Audit 2026-10-03 #9: at text size 1.3 the «احكيها» pill sat on «ليش
    // هاي بالذات», at 1.5 on «…», before any scroll. The viewport now stops
    // above the measured bar-and-pill block, so it covers no row at rest
    // either; the last row keeps the 12 pt gap above the pill.
    const viewportInset = (scroller: { props: { style?: unknown } }) => flat(scroller.props.style as never)?.marginBottom;

    it('stops TodayScreen\'s viewport above a custom tabClearance', async () => {
      await wrap(<TodayScreen tabClearance={165} />);
      const scroller = screen.getByTestId('today-scroll');
      expect(viewportInset(scroller)).toBe(165 - FLOATING_GAP);
      expect(flat(scroller.props.contentContainerStyle).paddingBottom).toBe(FLOATING_GAP);
    });

    it('defaults TodayScreen\'s viewport to the bar-and-pill clearance when unprovided', async () => {
      await wrap(<TodayScreen />);
      const scroller = screen.getByTestId('today-scroll');
      expect(viewportInset(scroller)).toBe(TAB_CLEARANCE - FLOATING_GAP);
    });

    it('stops CalendarScreen\'s viewport above a custom tabClearance', async () => {
      await wrap(<CalendarScreen tabClearance={175} />);
      const scroller = screen.getByTestId('calendar-scroll');
      expect(viewportInset(scroller)).toBe(175 - FLOATING_GAP);
    });

    it('defaults CalendarScreen\'s viewport to the bar-and-pill clearance when unprovided', async () => {
      await wrap(<CalendarScreen />);
      const scroller = screen.getByTestId('calendar-scroll');
      expect(viewportInset(scroller)).toBe(TAB_CLEARANCE - FLOATING_GAP);
    });
  });
});
