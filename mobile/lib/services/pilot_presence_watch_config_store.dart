import 'package:shared_preferences/shared_preferences.dart';

import 'contracts/pilot_presence_store.dart';
import 'shared_preferences_pilot_presence_store.dart';

abstract interface class PilotPresenceWatchConfigStore {
  Future<bool> readEnabled();
  Future<void> setEnabled(bool enabled);
  Future<void> clear();
}

final class SharedPreferencesPilotPresenceWatchConfigStore
    implements PilotPresenceWatchConfigStore {
  final PilotPresenceSharedStoreBridge sharedStoreBridge;
  final Future<SharedPreferences> Function() sharedPreferences;

  const SharedPreferencesPilotPresenceWatchConfigStore({
    this.sharedStoreBridge =
        const MethodChannelPilotPresenceSharedStoreBridge(),
    this.sharedPreferences = SharedPreferences.getInstance,
  });

  @override
  Future<bool> readEnabled() async {
    final sharedEnabled = await sharedStoreBridge.readBool(
      suiteName: PilotPresenceStoreKeys.appGroupIdentifier,
      key: PilotPresenceStoreKeys.watchEnabledV1,
    );
    if (sharedEnabled != null) return sharedEnabled;

    final prefs = await sharedPreferences();
    return prefs.getBool(PilotPresenceStoreKeys.watchEnabledV1) ?? false;
  }

  @override
  Future<void> setEnabled(bool enabled) async {
    await sharedStoreBridge.writeBool(
      suiteName: PilotPresenceStoreKeys.appGroupIdentifier,
      key: PilotPresenceStoreKeys.watchEnabledV1,
      value: enabled,
    );

    final prefs = await sharedPreferences();
    await prefs.setBool(PilotPresenceStoreKeys.watchEnabledV1, enabled);
  }

  @override
  Future<void> clear() async {
    await sharedStoreBridge.removeBool(
      suiteName: PilotPresenceStoreKeys.appGroupIdentifier,
      key: PilotPresenceStoreKeys.watchEnabledV1,
    );

    final prefs = await sharedPreferences();
    await prefs.remove(PilotPresenceStoreKeys.watchEnabledV1);
  }
}
