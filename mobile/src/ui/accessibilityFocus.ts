import { AccessibilityInfo, type View } from 'react-native';

/**
 * Moves the screen reader to `view`: for something that takes a page's place
 * and must be heard first (the entry question, M3b SIM-5). The same call the
 * capture page already uses to return focus to a control; a view that is not
 * mounted is left alone.
 */
export function focusForAccessibility(view: View | null): void {
  if (view) AccessibilityInfo.sendAccessibilityEvent(view, 'focus');
}
