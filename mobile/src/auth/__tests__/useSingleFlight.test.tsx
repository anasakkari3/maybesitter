import React, { useEffect } from 'react';
import { describe, expect, it } from '@jest/globals';
import { Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { useSingleFlight } from '../useSingleFlight';

/**
 * The guard behind both provider buttons and the email form.
 *
 * It exists because a `busy` boolean in state cannot stop a double tap: two
 * presses in the same frame both read the pre-update value and both pass
 * `if (busy) return`. On the Google button that meant two account choosers;
 * on the email form, two sign-up attempts for one tap.
 */

type Start = (action: () => Promise<void>) => Promise<void>;

/** Published from an effect: a component may not reassign outer bindings. */
const handle: { start: Start | null; busy: boolean } = { start: null, busy: false };

function Harness() {
  const { busy, run } = useSingleFlight();
  useEffect(() => {
    handle.start = run;
    handle.busy = busy;
  }, [run, busy]);
  return <Text testID="busy">{busy ? 'busy' : 'idle'}</Text>;
}

const start = (action: () => Promise<void>): Promise<void> | undefined => handle.start?.(action);

describe('useSingleFlight', () => {
  it('runs the action and reports busy while it is in flight', async () => {
    await render(<Harness />);
    let release = () => {};
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });

    let flight: Promise<void> | undefined;
    await act(async () => {
      flight = start(async () => pending);
    });
    expect(screen.getByTestId('busy')).toHaveTextContent('busy');

    await act(async () => {
      release();
      await flight;
    });
    expect(screen.getByTestId('busy')).toHaveTextContent('idle');
  });

  it('refuses a second call made in the same frame as the first', async () => {
    await render(<Harness />);
    let calls = 0;
    let release = () => {};
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const action = async () => {
      calls += 1;
      await pending;
    };

    let flights: Array<Promise<void> | undefined> = [];
    await act(async () => {
      // Both presses happen before React has re-rendered: the ref is what
      // makes the second one a no-op, and a state flag would not.
      flights = [start(action), start(action)];
    });
    expect(calls).toBe(1);

    await act(async () => {
      release();
      await Promise.all(flights);
    });
    expect(calls).toBe(1);
  });

  it('accepts the next call once the first has finished', async () => {
    await render(<Harness />);
    let calls = 0;
    const action = async () => {
      calls += 1;
    };

    await act(async () => {
      await start(action);
    });
    await act(async () => {
      await start(action);
    });
    expect(calls).toBe(2);
    expect(handle.busy).toBe(false);
  });

  it('releases the guard even when the action throws', async () => {
    await render(<Harness />);
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error('nope');
    };

    await act(async () => {
      await expect(start(failing)).rejects.toThrow('nope');
    });
    // A guard that stayed closed after a failure would leave the button dead
    // for the rest of the session.
    await act(async () => {
      await start(async () => {
        calls += 1;
      });
    });
    expect(calls).toBe(2);
  });
});
