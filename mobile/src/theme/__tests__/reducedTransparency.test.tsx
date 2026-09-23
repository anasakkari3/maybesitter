import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { afterEach, expect, it, jest } from '@jest/globals';
import { useReducedTransparency } from '../useReducedTransparency';

function Probe() { return <Text testID="transparency">{useReducedTransparency() ? 'solid' : 'glass'}</Text>; }
afterEach(() => { jest.restoreAllMocks(); });

it('follows the iOS setting and live changes, then removes the subscription', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceTransparencyEnabled').mockResolvedValue(true);
  let update: ((value: boolean) => void) | undefined;
  const remove = jest.fn();
  const listen = ((event: string, callback: unknown) => {
    if (event === 'reduceTransparencyChanged') update = callback as (value: boolean) => void;
    return { remove };
  }) as unknown as typeof AccessibilityInfo.addEventListener;
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(listen);
  const view = await render(<Probe />);
  await waitFor(() => expect(screen.getByTestId('transparency')).toHaveTextContent('solid'));
  await act(() => update?.(false));
  expect(screen.getByTestId('transparency')).toHaveTextContent('glass');
  await view.unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});
