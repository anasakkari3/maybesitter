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
    it('OnboardingChrome wraps screen content in KeyboardAvoidingView with iOS padding behavior', async () => {
      const src = readFileSync(join(__dirname, '../../features/onboarding/OnboardingChrome.tsx'), 'utf8');
      expect(src).toMatch(/behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);

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

    it('ReviewScreen wraps body in KeyboardAvoidingView with iOS padding behavior', async () => {
      const src = readFileSync(join(__dirname, '../ReviewScreen.tsx'), 'utf8');
      expect(src).toMatch(/behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);

      await wrap(<ReviewScreen />);
      const kav = screen.getByTestId('review-kav');
      expect(kav).toBeTruthy();
      expect(flat(kav.props.style).flex).toBe(1);
    });
  });

  describe('Tab Clearance propagation on root tab screens', () => {
    it('applies custom tabClearance to TodayScreen scroll container padding', async () => {
      await wrap(<TodayScreen tabClearance={165} />);
      const scroller = screen.getByTestId('today-scroll');
      expect(flat(scroller.props.contentContainerStyle).paddingBottom).toBe(165);
    });

    it('defaults TodayScreen scroll container padding to 130 when unprovided', async () => {
      await wrap(<TodayScreen />);
      const scroller = screen.getByTestId('today-scroll');
      expect(flat(scroller.props.contentContainerStyle).paddingBottom).toBe(130);
    });

    it('applies custom tabClearance to CalendarScreen scroll container padding', async () => {
      await wrap(<CalendarScreen tabClearance={175} />);
      const scroller = screen.getByTestId('calendar-scroll');
      expect(flat(scroller.props.contentContainerStyle).paddingBottom).toBe(175);
    });

    it('defaults CalendarScreen scroll container padding to 130 when unprovided', async () => {
      await wrap(<CalendarScreen />);
      const scroller = screen.getByTestId('calendar-scroll');
      expect(flat(scroller.props.contentContainerStyle).paddingBottom).toBe(130);
    });
  });
});
