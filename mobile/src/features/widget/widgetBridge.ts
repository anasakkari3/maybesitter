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
 * Both native libraries are required lazily. The iOS module does not exist on
 * Android and vice versa, and neither exists under Jest, where every test
 * injects a fake bridge instead.
 */
import { Platform } from 'react-native';
import { loadAndroidWidgetSnapshot, saveAndroidWidgetSnapshot } from '../../lib/deviceSettings/widget';
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
  const redraw = async () => {
    const { requestWidgetUpdate } = require('react-native-android-widget') as typeof import('react-native-android-widget');
    const { renderNextStepWidget, defaultWidgetTaskDeps } =
      require('./android/widgetTaskHandler') as typeof import('./android/widgetTaskHandler');
    const { ANDROID_WIDGET_NAME } = require('./android/NextStepWidget') as typeof import('./android/NextStepWidget');
    await requestWidgetUpdate({
      widgetName: ANDROID_WIDGET_NAME,
      renderWidget: () => renderNextStepWidget({ ...defaultWidgetTaskDeps, loadSnapshot: loadAndroidWidgetSnapshot }),
    });
  };
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
