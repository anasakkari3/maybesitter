import { StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { isolateAuto } from '../../i18n/bidi';
import {
  NOW,
  ZONE,
  initialState,
  panelHandler,
  panelState,
  prepare,
  readdMarker,
  readdTestIds,
  showPanel,
  teardown,
  type M5bHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 3.12 })),
}));

let harness: M5bHarness | undefined;

beforeEach(() => {
  process.env.TZ = ZONE;
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function flattened(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

function expectUnclipped(testID: string): void {
  const node = screen.getByTestId(testID);
  expect(node.props.numberOfLines).not.toBe(1);
  expect(node.props.ellipsizeMode).toBeUndefined();
}

describe('M5b-2b-2 locales, accessible names, and AX5', () => {
  it.each(['ar', 'en', 'he'] as const)('R3 App AX5 %s keeps the pending re-add wrapped, operable, and distinctly named', async language => {
    const id = `locale-${language}`;
    const title = `Project 42 ${language}`;
    const marker = readdMarker(id, 'pending', 'completed', undefined, { readd: { after: 'completed', title } });
    harness = await prepare(language, initialState(), panelHandler(panelState({ observations: [marker] })));
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-learned'));

    const rowId = readdTestIds.row(id);
    const rightId = readdTestIds.right(id);
    const wrongId = readdTestIds.wrong(id);
    expectUnclipped('m5b-learned');
    expectUnclipped(rowId);
    expect(flattened(rowId)?.flexWrap).toBe('wrap');

    const right = screen.getByTestId(rightId);
    const wrong = screen.getByTestId(wrongId);
    expect(right.props.accessibilityRole).toBe('button');
    expect(wrong.props.accessibilityRole).toBe('button');
    expect(flattened(rightId)?.minHeight).toBeGreaterThanOrEqual(44);
    expect(flattened(wrongId)?.minHeight).toBeGreaterThanOrEqual(44);
    expect(right.props.accessibilityLabel).toEqual(expect.any(String));
    expect(wrong.props.accessibilityLabel).toEqual(expect.any(String));
    expect(right.props.accessibilityLabel).not.toBe(wrong.props.accessibilityLabel);
    expect(right.props.accessibilityLabel).toContain(isolateAuto(title));
    expect(wrong.props.accessibilityLabel).toContain(isolateAuto(title));
  });
});
