import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import {
  NOW, ZONE, initialState, panelHandler, panelState, prepare, readdMarker, readdTestIds, showPanel, teardown,
  type M5bHarness,
} from './harness';

// Design critique 2026-10-23: the two answers on a guess row are set apart by
// a decorative dot that a screen reader skips; a confirmed row has none.
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

let harness: M5bHarness | undefined;
beforeEach(() => { process.env.TZ = ZONE; jest.useFakeTimers(); jest.setSystemTime(NOW); });
afterEach(async () => { await teardown(harness); harness = undefined; jest.useRealTimers(); });

it('a guess row separates «آه، هيك صح» from «مش صحيح» with a hidden dot; a confirmed row does not', async () => {
  harness = await prepare('ar', initialState(), panelHandler(panelState({
    observations: [readdMarker('g1'), readdMarker('c1', 'confirmed', 'completed')],
  })));
  await showPanel(harness);
  await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('m5b-learned'));

  const sep = screen.getByTestId('m5b-learned-sep-g1', { includeHiddenElements: true });
  expect(sep.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(sep.props.accessibilityElementsHidden).toBe(true);
  expect(screen.getByTestId(readdTestIds.right('g1'))).toBeTruthy();
  expect(screen.getByTestId(readdTestIds.wrong('g1'))).toBeTruthy();
  expect(screen.queryByTestId('m5b-learned-sep-c1', { includeHiddenElements: true })).toBeNull();
});
