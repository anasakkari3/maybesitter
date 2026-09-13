/**
 * The consent switches (UC-2.R4, #174).
 *
 * One property, and it is the whole reason this component exists separately:
 * the switch's position is the server's answer, never the tap. A switch that
 * flips optimistically tells somebody a thing about their own privacy that is
 * not yet true, and may never become true.
 */
import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { ServerToggle } from '../ServerToggle';
import en from '../../../i18n/locales/en.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function show(props: Partial<React.ComponentProps<typeof ServerToggle>> = {}) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <ServerToggle
          testID="toggle"
          title="Allow AI"
          value={false}
          onChange={async () => true}
          {...props}
        />
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('the position is the server’s', () => {
  it('renders what it is given, not what was tapped', async () => {
    // A write that succeeds does not move this control — the refetched value
    // does, on the next render, from the caller.
    const onChange = jest.fn(async () => true);
    await show({ value: false, onChange: onChange as never });
    fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
    expect(screen.getByTestId('toggle').props.value).toBe(false);
  });

  it('stays where it was when the write fails, and says so', async () => {
    await show({ value: false, onChange: (async () => false) as never });
    fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('toggle-failed')).not.toBeNull());
    expect(screen.getByTestId('toggle').props.value).toBe(false);
    expect(screen.queryByText(en.trustActionFailed)).not.toBeNull();
  });

  it('treats a thrown error the same as a refusal', async () => {
    await show({ onChange: (async () => { throw new Error('offline'); }) as never });
    fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('toggle-failed')).not.toBeNull());
  });
});

describe('while a write is in flight', () => {
  it('will not accept a second tap', async () => {
    let release: (value: boolean) => void = () => {};
    const pending = new Promise<boolean>(resolve => { release = resolve; });
    const onChange = jest.fn(() => pending);
    await show({ onChange: onChange as never });

    fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('toggle-busy')).not.toBeNull());
    fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    expect(onChange).toHaveBeenCalledTimes(1);

    release(true);
    await waitFor(() => expect(screen.queryByTestId('toggle-busy')).toBeNull());
  });
});

describe('when the caller has nothing to write against', () => {
  it('is disabled', async () => {
    const onChange = jest.fn(async () => true);
    await show({ disabled: true, onChange: onChange as never });
    fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('accessibility', () => {
  it('announces the state and the label', async () => {
    await show({ value: true });
    const control = screen.getByTestId('toggle');
    expect(control.props.accessibilityRole).toBe('switch');
    expect(control.props.accessibilityState).toMatchObject({ checked: true });
  });
});
