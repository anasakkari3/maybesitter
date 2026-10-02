import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pressable, Text } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { AppProvider, useApp } from '../AppContext';
import { THEME_STORAGE_KEY } from '../../lib/deviceSettings/theme';

/**
 * The scheme survives the app closing (UC-1.R2, #155).
 *
 * #155 promised an in-app System / Light / Dark override kept in device
 * storage. It was held in React state, so choosing Dark and killing the app
 * came back as System every time. Unmounting and mounting a second provider is
 * how a cold start looks from inside the tree: nothing is carried over in
 * memory, so anything that comes back came back from the store.
 *
 * The scheme is reached through buttons rather than by holding the model in a
 * variable, because that is how a person reaches it — and because a component
 * that writes to a binding outside itself is what the compiler lint forbids.
 */
function Probe() {
  const { themePref, scheme, actions } = useApp();
  return (
    <>
      <Text testID="pref">{themePref}</Text>
      <Text testID="scheme">{scheme}</Text>
      <Pressable testID="set-dark" onPress={() => actions.setThemePref('dark')} />
      <Pressable testID="set-light" onPress={() => actions.setThemePref('light')} />
      <Pressable testID="set-system" onPress={() => actions.setThemePref('system')} />
      <Pressable testID="cycle" onPress={() => actions.cycleTheme()} />
    </>
  );
}

/** A fresh provider, as a cold start builds one. */
const mount = () => render(<AppProvider><Probe /></AppProvider>);

const storedTheme = () => AsyncStorage.getItem(THEME_STORAGE_KEY);
const press = async (id: string) => { await fireEvent.press(screen.getByTestId(id)); };

describe('the theme preference across a restart', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('comes back Dark after the app is closed and opened', async () => {
    const first = await mount();
    await press('set-dark');
    await waitFor(async () => expect(await storedTheme()).toBe('dark'));
    await first.unmount();

    // A second provider, handed nothing but the store.
    await mount();
    await waitFor(() => expect(screen.getByTestId('pref')).toHaveTextContent('dark'));
  });

  it('remembers a choice made by cycling the Appearance row', async () => {
    const first = await mount();
    // dark (the default) → system → light → dark. The row is how most people set this.
    await press('cycle');
    await waitFor(async () => expect(await storedTheme()).toBe('system'));
    await press('cycle');
    await waitFor(async () => expect(await storedTheme()).toBe('light'));
    await press('cycle');
    await waitFor(async () => expect(await storedTheme()).toBe('dark'));
    await first.unmount();

    await mount();
    await waitFor(() => expect(screen.getByTestId('pref')).toHaveTextContent('dark'));
  });

  it('starts dark when nothing was ever chosen (Stitch, 2026-10-02)', async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId('pref')).toHaveTextContent('dark'));
    expect(screen.getByTestId('scheme')).toHaveTextContent('dark');
    // Defaulting is not choosing: nothing is written until the person picks.
    expect(await storedTheme()).toBeNull();
  });

  it('keeps an explicit light choice across a restart', async () => {
    const first = await mount();
    await press('set-light');
    await waitFor(async () => expect(await storedTheme()).toBe('light'));
    await first.unmount();

    await mount();
    await waitFor(() => expect(screen.getByTestId('scheme')).toHaveTextContent('light'));
  });

  it('follows the system again once the choice is set back to it', async () => {
    const first = await mount();
    await press('set-dark');
    await waitFor(async () => expect(await storedTheme()).toBe('dark'));
    await press('set-system');
    await waitFor(async () => expect(await storedTheme()).toBe('system'));
    await first.unmount();

    await mount();
    await waitFor(() => expect(screen.getByTestId('pref')).toHaveTextContent('system'));
  });

  it('ignores a stored value the app does not recognise', async () => {
    // Only a corrupted store or an older build writes this; it gets the default.
    await AsyncStorage.setItem(THEME_STORAGE_KEY, 'midnight');
    await mount();
    await waitFor(() => expect(screen.getByTestId('pref')).toHaveTextContent('dark'));
  });
});
