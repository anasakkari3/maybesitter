import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { TabBar } from '../../screens/TabBar';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions')
  .default as jest.Mock;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const TAB_IDS = ['tab-capture', 'tab-today', 'tab-calendar', 'tab-things', 'tab-watching'];

function NavigationProbe() {
  const { s } = useApp();
  return <Text testID="navigation-probe">{`${s.screen}|${s.captureSource}|${s.captureInput}`}</Text>;
}

async function show(fontScale = 1) {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <TabBar />
        <NavigationProbe />
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('tab-capture').props.accessibilityLabel).toBe('\u0627\u062d\u0643\u064a\u0647\u0627'));
  return view;
}

function barItems() {
  return within(screen.getByTestId('tab-bar')).getAllByRole('button');
}

function renderedLabel(button: ReturnType<typeof screen.getByTestId>) {
  return within(button).getByText(String(button.props.accessibilityLabel));
}

beforeEach(async () => {
  useWindowDimensions.mockReset();
  await AsyncStorage.clear();
});

afterEach(async () => {
  await cleanup();
  await AsyncStorage.clear();
});

it('A2 bottom bar: capture is the first of five equal items and still opens text capture from the tab', async () => {
  await show();

  await act(async () => { await fireEvent.press(screen.getByTestId('tab-capture')); });
  await waitFor(() => expect(screen.getByTestId('navigation-probe')).toHaveTextContent('capture|tab|text'));

  const items = barItems();
  expect(items.map(item => item.props.testID)).toEqual(TAB_IDS);
  expect(items.map(item => StyleSheet.flatten(item.props.style)?.flex)).toEqual([1, 1, 1, 1, 1]);
});

it('A2 bottom bar: capture exposes the localized Say it name but paints only the app mark', async () => {
  await show();

  const capture = screen.getByTestId('tab-capture');
  expect(capture.props.accessibilityLabel).toBe('\u0627\u062d\u0643\u064a\u0647\u0627');
  expect(within(capture).queryByText('\u0627\u062d\u0643\u064a\u0647\u0627')).toBeNull();
  expect(capture.props.accessibilityRole).toBe('button');
});

it('A2 bottom bar: default labels are 13 points and are not clamped or ellipsized', async () => {
  await show(1);

  const labelledItems = barItems().filter(item => item.props.testID !== 'tab-capture');
  expect(labelledItems).toHaveLength(4);
  for (const item of labelledItems) {
    const label = renderedLabel(item);
    expect(StyleSheet.flatten(label.props.style)?.fontSize).toBe(13);
    expect(label.props.numberOfLines).not.toBe(1);
    expect(label.props.ellipsizeMode).toBeUndefined();
  }
});

it('A2 bottom bar: 1.24× labels stay at least 12 points without truncation and accessibility sizes keep all five names', async () => {
  const view = await show(1.24);
  const labelledItems = barItems().filter(item => item.props.testID !== 'tab-capture');
  for (const item of labelledItems) {
    const label = renderedLabel(item);
    expect(StyleSheet.flatten(label.props.style)?.fontSize).toBeGreaterThanOrEqual(12);
    expect(label.props.numberOfLines).not.toBe(1);
    expect(label.props.ellipsizeMode).toBeUndefined();
  }

  await view.unmount();
  await show(2);
  for (const id of TAB_IDS) {
    const item = screen.getByTestId(id);
    expect(typeof item.props.accessibilityLabel).toBe('string');
    expect(item.props.accessibilityLabel.length).toBeGreaterThan(0);
  }
});
