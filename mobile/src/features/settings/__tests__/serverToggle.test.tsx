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
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { ServerToggle } from '../ServerToggle';
import en from '../../../i18n/locales/en.json';
import { NetworkError, ServerError, TimeoutError, ValidationError } from '../../../api/errors';

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
    await fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
    expect(screen.getByTestId('toggle').props.value).toBe(false);
  });

  it('stays where it was when the write fails, and says so', async () => {
    await show({ value: false, onChange: (async () => false) as never });
    await fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('toggle-failed')).not.toBeNull());
    expect(screen.getByTestId('toggle').props.value).toBe(false);
    // `false` says the write did not take, not why. It used to read «ما وصل
    // للسيرفر», which is a claim about the network nobody had checked.
    expect(screen.queryByText(en.trustActionNotSaved)).not.toBeNull();
    expect(screen.queryByText(en.trustActionFailed)).toBeNull();
  });

  it('treats a thrown error the same as a refusal', async () => {
    await show({ onChange: (async () => { throw new Error('offline'); }) as never });
    await fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('toggle-failed')).not.toBeNull());
  });
});

describe('which failure it says (UAT round 3, N9)', () => {
  async function failWith(error: unknown) {
    await show({ onChange: (async () => { throw error; }) as never });
    await fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('toggle-failed')).not.toBeNull());
  }

  it('a refusal the server answered never says it did not reach the server', async () => {
    // The literal N9 answer: 400 from `/api/mobile/pilot/trust`.
    await failWith(new ValidationError('calendar consent is available only after first value'));
    expect(screen.queryByText(en.trustActionFailed)).toBeNull();
    expect(screen.queryByText(en.trustActionRefused)).not.toBeNull();
    // The server's own words are never shown.
    expect(screen.queryByText(/first value/)).toBeNull();
  });

  it('a request that never arrived says so', async () => {
    await failWith(new NetworkError('offline'));
    expect(screen.queryByText(en.trustActionFailed)).not.toBeNull();
  });

  it('a request nobody answered in time says so too', async () => {
    await failWith(new TimeoutError('slow'));
    expect(screen.queryByText(en.trustActionFailed)).not.toBeNull();
  });

  it('a server fault reads as ours, not as the network', async () => {
    await failWith(new ServerError('boom', 500));
    expect(screen.queryByText(en.trustActionFailed)).toBeNull();
    expect(screen.queryByText(en.errorsServer)).not.toBeNull();
  });

  it('a failure that is not an answer from the server claims nothing about it', async () => {
    await failWith(new Error('the phone said no'));
    expect(screen.queryByText(en.trustActionFailed)).toBeNull();
    expect(screen.queryByText(en.trustActionNotSaved)).not.toBeNull();
  });
});

/*
 * FZ2 review M5: the failure line appears under the switch after the tap, and
 * nothing told a screen reader. TalkBack hears it from a live region;
 * VoiceOver is told the line itself.
 */
describe('a failure is announced', () => {
  it('sits in a live region, and VoiceOver is told the line once it appears', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    announce.mockClear();
    await show({ onChange: (async () => { throw new NetworkError('offline'); }) as never });
    expect(announce).not.toHaveBeenCalled();
    await fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('toggle-failed')).not.toBeNull());
    expect(screen.getByTestId('toggle-failed-live').props.accessibilityLiveRegion).toBe('polite');
    await waitFor(() => expect(announce).toHaveBeenCalledWith(en.trustActionFailed));
    announce.mockRestore();
  });
});

describe('while a write is in flight', () => {
  it('will not accept a second tap', async () => {
    let release: (value: boolean) => void = () => {};
    const pending = new Promise<boolean>(resolve => { release = resolve; });
    const onChange = jest.fn(() => pending);
    await show({ onChange: onChange as never });

    await fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('toggle-busy')).not.toBeNull());
    await fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
    expect(onChange).toHaveBeenCalledTimes(1);

    release(true);
    await waitFor(() => expect(screen.queryByTestId('toggle-busy')).toBeNull());
  });
});

describe('when the caller has nothing to write against', () => {
  it('is disabled', async () => {
    const onChange = jest.fn(async () => true);
    await show({ disabled: true, onChange: onChange as never });
    await fireEvent(screen.getByTestId('toggle'), 'valueChange', true);
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
