/**
 * The launch URL is the link the process was started with, and it is used
 * once (C13.3).
 *
 * `Linking.getInitialURL()` keeps returning that URL for the life of the
 * process. `Root` — which owns link handling — unmounts on sign-out and mounts
 * again on the next sign-in, so asking again replayed account A's commitment
 * link to account B after every sign-in (seen on the simulator, 2 of 2).
 */
import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import { Linking, Text } from 'react-native';
import { resetInitialLinkForTests, useLinks } from '../links';

function Consumer({ open }: { open: (id: string) => void }) {
  useLinks({
    jump: () => {},
    openCommitment: open,
    openPlan: () => {},
    openNextStep: () => {},
    openCapture: () => {},
    setLang: () => {},
    setThemePref: () => {},
  });
  return <Text>root</Text>;
}

afterEach(() => {
  jest.restoreAllMocks();
  resetInitialLinkForTests();
});

describe('the launch URL', () => {
  it('is handled by the first mount only, not replayed after a re-sign-in', async () => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('maybesitter://commitments/a-item-1');
    jest.spyOn(Linking, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
    const open = jest.fn<(id: string) => void>();

    // Signed in as A: the launch link opens A's commitment.
    const first = await render(<Consumer open={open} />);
    await act(async () => {});
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenLastCalledWith('a-item-1');

    // Sign-out unmounts Root; B signs in and Root mounts again in the same process.
    await first.unmount();
    await render(<Consumer open={open} />);
    await act(async () => {});
    expect(open).toHaveBeenCalledTimes(1);
  });
});
