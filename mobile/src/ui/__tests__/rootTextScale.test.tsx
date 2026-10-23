/**
 * The app root re-measures every screen's text after a live text-size change
 * (simulator 2026-10-23, follow-up to #786).
 *
 * #786 bounded «هيك فهمت» alone. Outside it, the same pass found the learned
 * card drawn as slivers at AX5, the Watching header leaving a gap and the tab
 * bar wider than the screen after AX5 → default. `DirectionRoot` — the view
 * every screen, signed in or not, renders under — now holds the one
 * `RemeasureOnTextScale`, so this file renders through it.
 *
 * The scale changes as on a phone: `Dimensions` emits a change and the real
 * `useWindowDimensions` hears it. The global jest setup replaces that hook
 * with a fixed reading; this file restores the real one (per file) and puts
 * the reading back to the default after each test.
 */
import React from 'react';
import { Dimensions, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { TabBar } from '../../screens/TabBar';
import { DirectionRoot } from '../DirectionRoot';
import { Btn, Txt } from '../primitives';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const AX5 = 3.12;
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const TAB_IDS = ['tab-capture', 'tab-today', 'tab-calendar', 'tab-things', 'tab-watching'];
const LABEL_IDS = ['tab-today-label', 'tab-calendar-label', 'tab-things-label', 'tab-watching-label'];

function setFontScale(fontScale: number, width = 390, height = 844) {
  const window = { width, height, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

afterEach(async () => {
  await cleanup();
  setFontScale(1);
  await AsyncStorage.clear();
});

async function mount(children: React.ReactNode, fontScale = 1) {
  setFontScale(fontScale);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <DirectionRoot>{children}</DirectionRoot>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

/** A screen in miniature: a control, a standalone paragraph, an input the person typed into, a scroller. */
function Probe() {
  const [draft, setDraft] = React.useState('');
  return (
    <ScrollView testID="probe-scroll">
      <Btn testID="probe-button" label="probe" onPress={() => undefined}>
        <Txt testID="probe-button-text">زر</Txt>
      </Btn>
      <Txt testID="probe-paragraph">فقرة لحالها</Txt>
      <View testID="probe-wrapper" accessible accessibilityRole="text" accessibilityLabel="كلام">
        <Txt testID="probe-wrapped" accessible={false}>كلام</Txt>
      </View>
      <TextInput testID="probe-input" value={draft} onChangeText={setDraft} />
    </ScrollView>
  );
}

describe('the root boundary', () => {
  it('replaces every paragraph on a scale change and nothing else: controls, wrappers, the input and its words, the scroller stay', async () => {
    await mount(<Probe />);
    await act(async () => { await fireEvent.changeText(screen.getByTestId('probe-input'), 'بدي روح عالبنك'); });
    const kept = ['probe-scroll', 'probe-button', 'probe-wrapper', 'probe-input'].map((id) => screen.getByTestId(id));
    let text = ['probe-button-text', 'probe-paragraph', 'probe-wrapped'].map((id) => screen.getByTestId(id));

    for (const scale of [AX5, 1, 1.12]) {
      await act(async () => { setFontScale(scale); });
      ['probe-scroll', 'probe-button', 'probe-wrapper', 'probe-input'].forEach((id, i) => expect(screen.getByTestId(id)).toBe(kept[i]));
      // Whatever was typed is still there: a TextInput is not a Txt.
      expect(screen.getByTestId('probe-input').props.value).toBe('بدي روح عالبنك');
      const next = ['probe-button-text', 'probe-paragraph', 'probe-wrapped'].map((id) => screen.getByTestId(id));
      next.forEach((node, i) => expect(node).not.toBe(text[i]));
      text = next;
    }
  });

  it('replaces nothing on a rotation (same scale)', async () => {
    await mount(<Probe />, AX5);
    const before = screen.getByTestId('probe-paragraph');
    await act(async () => { setFontScale(AX5, 844, 390); });
    expect(screen.getByTestId('probe-paragraph')).toBe(before);
  });
});

/** Each tab item's flattened style. */
function slotStyles() {
  return TAB_IDS.map((id) => StyleSheet.flatten(screen.getByTestId(id).props.style) as Record<string, unknown>);
}

describe('the tab bar after a live text-size change', () => {
  it('default → AX5 → default: labels are new paragraphs, the items stay mounted, and each slot is what a fresh open gives', async () => {
    await mount(<TabBar />);
    await waitFor(() => expect(screen.getByTestId('tab-capture').props.accessibilityLabel).toBe('احكيها'));
    const items = TAB_IDS.map((id) => screen.getByTestId(id));
    const fresh = slotStyles();
    const labels = LABEL_IDS.map((id) => screen.getByTestId(id));
    // A fifth each, from a zero width that grows: never a `flex` basis, which
    // Yoga on Fabric keeps across the change (theme/textScale, growInRow).
    for (const style of fresh) {
      expect(style).toEqual(expect.objectContaining({ flexGrow: 1, flexShrink: 1, width: 0 }));
      expect(style.flex).toBeUndefined();
      expect(style.flexBasis).toBeUndefined();
    }

    await act(async () => { setFontScale(AX5); });
    expect(StyleSheet.flatten(screen.getByTestId('tab-bar-row').props.style).flexWrap).toBe('wrap');
    for (const style of slotStyles()) {
      expect(style.width).toBe('32%');
      expect(style.flex).toBeUndefined();
      expect(style.flexBasis).toBeUndefined();
    }
    const atAx5 = LABEL_IDS.map((id) => screen.getByTestId(id));
    atAx5.forEach((node, i) => expect(node).not.toBe(labels[i]));

    await act(async () => { setFontScale(1); });
    // One row again, each slot exactly as it was opened at the default size.
    expect(StyleSheet.flatten(screen.getByTestId('tab-bar-row').props.style).flexWrap).toBe('nowrap');
    expect(slotStyles()).toEqual(fresh);
    LABEL_IDS.map((id) => screen.getByTestId(id)).forEach((node, i) => expect(node).not.toBe(atAx5[i]));
    // The buttons — what a screen reader is on — are the same ones throughout.
    TAB_IDS.forEach((id, i) => expect(screen.getByTestId(id)).toBe(items[i]));
    // …and still read their names.
    expect(within(screen.getByTestId('tab-today')).getByTestId('tab-today-label')).toBeTruthy();
  });
});
