/**
 * The optional explanation (owner audit 2026-10-06, images 5–9): closed by
 * default, the text absent until the arrow is pressed, and gone again on the
 * second press.
 */
import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { Disclosure } from '../Disclosure';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

async function mount(children?: React.ReactNode) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <Disclosure id="gentle" body="A long explanation." label="Gentle reminders">{children}</Disclosure>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('Disclosure', () => {
  it('does not render the explanation until it is opened', async () => {
    await mount(<Text>Gentle reminders</Text>);
    expect(screen.getByText('Gentle reminders')).toBeTruthy();
    expect(screen.queryByTestId('gentle-why-body')).toBeNull();
    expect(screen.queryByText('A long explanation.')).toBeNull();
  });

  it('opens on the first press and closes on the second, saying which state it is in', async () => {
    await mount();
    const control = screen.getByTestId('gentle-why');
    expect(control.props.accessibilityState).toMatchObject({ expanded: false });
    expect(control.props.accessibilityRole).toBe('button');

    await act(async () => { await fireEvent.press(control); });
    expect(screen.getByTestId('gentle-why-body')).toBeTruthy();
    expect(screen.getByTestId('gentle-why').props.accessibilityState).toMatchObject({ expanded: true });

    await act(async () => { await fireEvent.press(screen.getByTestId('gentle-why')); });
    expect(screen.queryByTestId('gentle-why-body')).toBeNull();
  });

  it('names what it explains for a screen reader, and is at least 44 points square', async () => {
    await mount();
    const control = screen.getByTestId('gentle-why');
    expect(String(control.props.accessibilityLabel)).toContain('Gentle reminders');
    const style = Object.assign({}, ...[control.props.style].flat(Infinity).filter(Boolean));
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });

  it('stretches across its row, so the title beside the arrow keeps its width at the largest text sizes', async () => {
    await mount(<Text>Gentle reminders</Text>);
    // A stacked section gave the row no width and the title collapsed to
    // nothing at AX5 on a device (2026-10-06).
    const root = screen.getByTestId('gentle-disclosure');
    const style = Object.assign({}, ...[root.props.style].flat(Infinity).filter(Boolean));
    expect(style.alignSelf).toBe('stretch');
  });
});
