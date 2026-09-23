import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
// RNTL v14's render() is asynchronous — it resolves to the query object.
import { render, waitFor } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

// The colour scheme is the one input a test cannot drive through the app's
// own actions, so it is mocked per case.
const mockScheme = jest.fn<() => 'light' | 'dark'>(() => 'light');
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, useApp } from '../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { Card, Pill, Txt } from '../../ui/primitives';
import { Tag } from '../../ui/chrome';
import { color } from '../../theme/tokens';

function Harness({ children }: { children: React.ReactNode }) {
  return <AppProvider>{children}</AppProvider>;
}

/** Start the app as a user who already chose this language. */
async function withStoredLanguage(lang: 'ar' | 'en') {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
}

/** Reads the live palette and language out of the provider. */
function Probe() {
  const { p, ar, scheme } = useApp();
  return <Text testID="probe">{`${scheme}|${ar ? 'rtl' : 'ltr'}|${p.bg}|${p.onAccent}`}</Text>;
}

describe('primitives render in both schemes', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it(`${scheme}: text, buttons, badges and cards use that scheme's tokens`, async () => {
      mockScheme.mockReturnValue(scheme);
      await withStoredLanguage('ar');
      const view = await render(
        <Harness>
          <Probe />
          <Txt>مرحبا</Txt>
          <Pill label="تمّت" onPress={() => {}} />
          <Tag kind="must" label="ضروري" />
          <Card>
            <Txt>بطاقة</Txt>
          </Card>
        </Harness>,
      );

      expect(view.getByText('مرحبا')).toBeTruthy();
      expect(view.getByText('بطاقة')).toBeTruthy();
      // The label is both the visible text and the accessibility name.
      expect(view.getAllByRole('button', { name: 'تمّت' }).length).toBeGreaterThan(0);
      // Round 2's `Tag` replaced `ImpBadge`: a word in the scheme's own
      // "must" colour, not a button.
      const badge = view.getByText('ضروري');
      expect(StyleSheet.flatten(badge.props.style)).toMatchObject({ color: color[scheme].must });

      const probe = view.getByTestId('probe').props.children as string;
      expect(probe).toBe(`${scheme}|rtl|${color[scheme].background}|${color[scheme].onBrand}`);
    });
  }
});

describe('writing direction follows the language', () => {
  const directionOf = (node: { props: Record<string, unknown> }) =>
    [node.props.style].flat(3).find((s) => s && typeof s === 'object' && 'writingDirection' in s) as
      | { writingDirection?: string }
      | undefined;

  it('Arabic is right-to-left by default', async () => {
    mockScheme.mockReturnValue('light');
    await withStoredLanguage('ar');
    const view = await render(
      <Harness>
        <Txt>نص</Txt>
      </Harness>,
    );
    await waitFor(() => {
      expect(directionOf(view.getByText('نص'))?.writingDirection).toBe('rtl');
    });
  });

  it('English mirrors to left-to-right', async () => {
    mockScheme.mockReturnValue('light');
    await withStoredLanguage('en');

    const view = await render(
      <Harness>
        <Txt>text</Txt>
      </Harness>,
    );
    await waitFor(() => {
      expect(directionOf(view.getByText('text'))?.writingDirection).toBe('ltr');
    });
  });
});

describe('the disabled state is announced, not just dimmed', () => {
  it('marks a disabled pill as disabled for assistive technology', async () => {
    mockScheme.mockReturnValue('light');
    await withStoredLanguage('ar');
    const view = await render(
      <Harness>
        <Pill label="تمّت" disabled />
      </Harness>,
    );
    const button = view.getAllByRole('button', { name: 'تمّت' })[0];
    expect(button?.props.accessibilityState?.disabled).toBe(true);
  });
});
