/**
 * The opt-in belongs to one account (UC-3.R1, #203).
 *
 * The store is keyed by uid, but the hook holds the last answer in state. In
 * the renders between a uid change and the new account's read landing, that
 * state still says what the *previous* account chose — and the snapshot writer
 * reads it. The hook must answer "not allowed" for the new uid until its own
 * answer is in.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useWidgetTitlesAllowed } from '../useWidgetSnapshotSync';
import {
  resetWidgetSettingsForTests,
  saveWidgetTitlesAllowed,
} from '../../../lib/deviceSettings/widget';

jest.mock('../widgetBridge', () => ({ createNativeWidgetBridge: () => ({ write: async () => {}, clear: async () => {} }) }));

function Probe({ uid }: { uid: string }) {
  const { allowed, resolved } = useWidgetTitlesAllowed(uid);
  return <Text testID="state">{`${allowed}/${resolved}`}</Text>;
}

beforeEach(async () => {
  resetWidgetSettingsForTests();
  await AsyncStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useWidgetTitlesAllowed', () => {
  it('does not lend one account’s yes to the next while the next one’s answer is still loading', async () => {
    await saveWidgetTitlesAllowed('account-a', true);
    const view = await render(<Probe uid="account-a" />);
    await waitFor(() => expect(screen.getByTestId('state').props.children).toBe('true/true'));

    // Account B's read never comes back.
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      view.rerender(<Probe uid="account-b" />);
    });
    expect(screen.getByTestId('state').props.children).toBe('false/false');
  });
});
