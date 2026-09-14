/**
 * The gesture root, which the swipeable rows need and the app did not have.
 *
 * `todayScreen.test.tsx` renders active rows — including `SwipeableRow` — and
 * passes, because under Jest `react-native-gesture-handler` never checks for
 * its root view. On a device it does: the 2026-09-14 audit found that one real
 * active row on Today replaced the whole screen with
 *
 *   "PanGestureHandler must be used as a descendant of GestureHandlerRootView"
 *
 * and an empty Today was the only Today that worked. So the assertion has to be
 * about the tree the app actually mounts, not about a row rendering in a
 * harness that cannot fail.
 *
 * `GestureHandlerRootView` renders as a plain `View`, so the real export is
 * swapped for a marker: this asserts the app mounts *that component*, not that
 * some view carries an agreed `testID`.
 */
import React from 'react';
import { View } from 'react-native';
import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';

jest.mock('react-native-gesture-handler', () => {
  const actual = jest.requireActual('react-native-gesture-handler') as object;
  const mockReact = jest.requireActual('react') as typeof React;
  const mockRn = jest.requireActual('react-native') as { View: typeof View };
  return {
    ...actual,
    GestureHandlerRootView: ({ children }: { children?: React.ReactNode }) =>
      mockReact.createElement(mockRn.View, { testID: 'gesture-root' }, children),
  };
});

// `expo-font` reaches for `expo-asset`, which is native and absent here. The
// faces are not what this file is about: it asserts the shape of the provider
// stack, so the loader reports "loaded" and the tree renders.
jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));

// eslint-disable-next-line import/first -- must follow the mocks above.
import App from '../../App';

describe('the app root', () => {
  it('mounts a gesture root, so a swipeable row has somewhere to attach', async () => {
    const view = await render(<App />);
    expect(view.queryAllByTestId('gesture-root')).toHaveLength(1);
  });

  it('puts the gesture root outermost, so the error screen is inside it too', async () => {
    const view = await render(<App />);
    const tree = view.toJSON();
    const outermost = Array.isArray(tree) ? tree[0] : tree;
    expect(outermost?.props?.testID).toBe('gesture-root');
  });
});
