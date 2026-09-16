const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

/**
 * Android Manifest fixups for Expo CNG build baseline (#458).
 *
 * 1. `com.google.firebase.messaging.default_notification_channel_id`:
 *    `expo-notifications` sets `defaultChannel: 'maybesitter_general'` in `app.config.ts`,
 *    which writes a `<meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="maybesitter_general" />`
 *    tag into `AndroidManifest.xml`.
 *    `@react-native-firebase/messaging` defines the same meta-data key in its library manifest
 *    with an empty default value. Without `tools:replace="android:value"`, Gradle's Android Manifest
 *    Merger task (`:app:processDebugMainManifest`) fails due to conflicting attribute values.
 *    This fixup attaches `tools:replace="android:value"` to that meta-data element.
 *
 * 2. Receiver deduplication:
 *    Ensures receiver entries (such as widget receivers) in `<application>` are deduplicated by `android:name`.
 *
 * NOTE ON PLUGIN ORDERING:
 * Expo config plugin mods execute in reverse registration order.
 * This plugin must be listed BEFORE `expo-notifications` in `app.config.ts` so its `withAndroidManifest`
 * mod executes AFTER `expo-notifications` has inserted the default channel meta-data element.
 */
function withAndroidFixups(config) {
  return withAndroidManifest(config, (modConfig) => {
    const androidManifest = modConfig.modResults;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);

    // Ensure xmlns:tools is present on <manifest>
    if (!androidManifest.manifest.$) {
      androidManifest.manifest.$ = {};
    }
    androidManifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    // 1. Fix default notification channel meta-data conflict with @react-native-firebase/messaging
    if (Array.isArray(application['meta-data'])) {
      const channelMetaData = application['meta-data'].find(
        (item) => item.$ && item.$['android:name'] === 'com.google.firebase.messaging.default_notification_channel_id',
      );
      if (channelMetaData && channelMetaData.$) {
        const existingReplace = channelMetaData.$['tools:replace'];
        if (!existingReplace) {
          channelMetaData.$['tools:replace'] = 'android:value';
        } else if (!existingReplace.includes('android:value')) {
          channelMetaData.$['tools:replace'] = `${existingReplace},android:value`;
        }
      }
    }

    // 2. Receiver deduplication
    if (Array.isArray(application.receiver)) {
      const seen = new Set();
      application.receiver = application.receiver.filter((receiver) => {
        const name = receiver.$ && receiver.$['android:name'];
        if (!name) return true;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      });
    }

    return modConfig;
  });
}

module.exports = withAndroidFixups;
