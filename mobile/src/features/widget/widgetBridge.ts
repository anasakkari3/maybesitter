/**
 * Where a widget snapshot goes, per platform (UC-3.R1, #203).
 *
 * iOS  — `UserDefaults(suiteName: "group.com.maybesitter.app")` through
 *        `@bacons/apple-targets`' `ExtensionStorage`, then
 *        `WidgetCenter.reloadAllTimelines()`. The WidgetKit extension in
 *        `targets/widget/` reads the same key.
 * Android — the snapshot store in `lib/deviceSettings/widget.ts`, then
 *        `requestWidgetUpdate`, which re-draws every placed `NextStep` widget
 *        from it right away.
 *
 * `react-native-android-widget` is imported normally: off Android it resolves to
 * an inert module. `@bacons/apple-targets` is required lazily, inside the iOS
 * branch, because its entry reads the `expo` global at load and must not run
 * anywhere that global may be missing. Tests inject a fake bridge.
 */
import { Platform } from 'react-native';
import { requestWidgetUpdate } from 'react-native-android-widget';
import { saveAndroidWidgetSnapshot } from '../../lib/deviceSettings/widget';
import { ANDROID_WIDGET_NAME } from './android/NextStepWidget';
import { renderNextStepWidget } from './android/widgetTaskHandler';
import { APP_GROUP, SNAPSHOT_KEY } from './snapshot';

export interface WidgetBridge {
  /** Replaces the snapshot and asks the widgets to redraw. */
  write(json: string): Promise<void>;
  /** Removes the snapshot and asks the widgets to redraw (sign-out). */
  clear(): Promise<void>;
}

export const noopWidgetBridge: WidgetBridge = {
  write: async () => {},
  clear: async () => {},
};

function iosBridge(): WidgetBridge {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see the header: loaded only on iOS.
  const { ExtensionStorage } = require('@bacons/apple-targets') as typeof import('@bacons/apple-targets');
  const storage = new ExtensionStorage(APP_GROUP);
  return {
    write: async (json) => {
      storage.set(SNAPSHOT_KEY, json);
      ExtensionStorage.reloadWidget();
    },
    clear: async () => {
      storage.remove(SNAPSHOT_KEY);
      ExtensionStorage.reloadWidget();
    },
  };
}

function androidBridge(): WidgetBridge {
  // Drawn from the store just written, by the same function the headless task uses.
  const redraw = () => requestWidgetUpdate({ widgetName: ANDROID_WIDGET_NAME, renderWidget: () => renderNextStepWidget() });
  return {
    write: async (json) => {
      await saveAndroidWidgetSnapshot(json);
      await redraw();
    },
    clear: async () => {
      await saveAndroidWidgetSnapshot(null);
      await redraw();
    },
  };
}

/** The real bridge for this platform; inert anywhere else. Never throws. */
export function createNativeWidgetBridge(): WidgetBridge {
  try {
    if (Platform.OS === 'ios') return guarded(iosBridge());
    if (Platform.OS === 'android') return guarded(androidBridge());
  } catch {
    // No native module in this build (Expo Go, a test): no widget to feed.
  }
  return noopWidgetBridge;
}

/** A widget that cannot be written is never a reason for the app to fail. */
function guarded(bridge: WidgetBridge): WidgetBridge {
  return {
    write: (json) => bridge.write(json).catch(() => {}),
    clear: () => bridge.clear().catch(() => {}),
  };
}
