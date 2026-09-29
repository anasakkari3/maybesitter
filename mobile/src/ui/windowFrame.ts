import type { View } from 'react-native';

/** A view's vertical extent in window coordinates, the space the keyboard reports in. */
export type WindowFrame = { y: number; height: number };

/**
 * Where `view` sits on the screen, or null when it is not mounted.
 *
 * Its own module so a test can stand in for the native measurement: under
 * Jest `measureInWindow` never calls back.
 */
export function measureWindowFrame(view: View | null): Promise<WindowFrame | null> {
  return new Promise((resolve) => {
    if (!view) {
      resolve(null);
      return;
    }
    view.measureInWindow((_x, y, _width, height) => resolve({ y, height }));
  });
}
