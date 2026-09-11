import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
// RNTL v14's render() is asynchronous — it resolves to the query object.
import { render } from '@testing-library/react-native';
import { Text } from 'react-native';

// The colour scheme is the one input a test cannot drive through the app's
// own actions, so it is mocked per case.
const mockScheme = jest.fn<() => 'light' | 'dark'>(() => 'light');
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme(),
}));

import { AppProvider, useApp } from '../../state/AppContext';
import { Card, HeaderPill, ImpBadge, Pill, Txt } from '../../ui/primitives';
import { color } from '../../theme/tokens';

function Harness({ children }: { children: React.ReactNode }) {
  return <AppProvider>{children}</AppProvider>;
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
      const view = await render(
        <Harness>
          <Probe />
          <Txt>مرحبا</Txt>
          <Pill label="تمّت" onPress={() => {}} />
          <HeaderPill label="رجوع" onPress={() => {}} />
          <ImpBadge imp="must" />
          <Card>
            <Txt>بطاقة</Txt>
          </Card>
        </Harness>,
      );

      expect(view.getByText('مرحبا')).toBeTruthy();
      expect(view.getByText('بطاقة')).toBeTruthy();
      // The label is both the visible text and the accessibility name.
      expect(view.getAllByRole('button', { name: 'تمّت' }).length).toBeGreaterThan(0);
      expect(view.getAllByRole('button', { name: 'رجوع' }).length).toBeGreaterThan(0);

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
    const view = await render(
      <Harness>
        <Txt>نص</Txt>
      </Harness>,
    );
    expect(directionOf(view.getByText('نص'))?.writingDirection).toBe('rtl');
  });

  it('English mirrors to left-to-right', async () => {
    mockScheme.mockReturnValue('light');

    function SwitchToEnglish() {
      const { actions, lang } = useApp();
      React.useEffect(() => {
        if (lang === 'ar') actions.setLang('en');
        // Runs once; the provider keeps the choice.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <Txt>text</Txt>;
    }

    const view = await render(
      <Harness>
        <SwitchToEnglish />
      </Harness>,
    );
    expect(directionOf(view.getByText('text'))?.writingDirection).toBe('ltr');
  });
});

describe('the disabled state is announced, not just dimmed', () => {
  it('marks a disabled pill as disabled for assistive technology', async () => {
    mockScheme.mockReturnValue('light');
    const view = await render(
      <Harness>
        <Pill label="تمّت" disabled />
      </Harness>,
    );
    const button = view.getAllByRole('button', { name: 'تمّت' })[0];
    expect(button?.props.accessibilityState?.disabled).toBe(true);
  });
});
