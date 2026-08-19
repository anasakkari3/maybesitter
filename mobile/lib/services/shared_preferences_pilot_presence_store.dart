import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/pilot_presence.dart';
import 'contracts/pilot_presence_store.dart';

abstract interface class PilotPresenceSharedStoreBridge {
  Future<String?> readString({required String suiteName, required String key});

  Future<bool?> readBool({required String suiteName, required String key});

  Future<bool> writeString({
    required String suiteName,
    required String key,
    required String value,
  });

  Future<bool> writeBool({
    required String suiteName,
    required String key,
    required bool value,
  });

  Future<void> removeString({required String suiteName, required String key});

  Future<void> removeBool({required String suiteName, required String key});
}

class MethodChannelPilotPresenceSharedStoreBridge
    implements PilotPresenceSharedStoreBridge {
  static const MethodChannel _channel = MethodChannel(
    'com.maybesitter.mobile/pilot_presence_shared_store',
  );

  const MethodChannelPilotPresenceSharedStoreBridge();

  @override
  Future<String?> readString({
    required String suiteName,
    required String key,
  }) async {
    try {
      return await _channel.invokeMethod<String>('readString', {
        'suiteName': suiteName,
        'key': key,
      });
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  @override
  Future<bool?> readBool({
    required String suiteName,
    required String key,
  }) async {
    try {
      return await _channel.invokeMethod<bool>('readBool', {
        'suiteName': suiteName,
        'key': key,
      });
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  @override
  Future<bool> writeString({
    required String suiteName,
    required String key,
    required String value,
  }) async {
    try {
      return await _channel.invokeMethod<bool>('writeString', {
            'suiteName': suiteName,
            'key': key,
            'value': value,
          }) ??
          false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }

  @override
  Future<bool> writeBool({
    required String suiteName,
    required String key,
    required bool value,
  }) async {
    try {
      return await _channel.invokeMethod<bool>('writeBool', {
            'suiteName': suiteName,
            'key': key,
            'value': value,
          }) ??
          false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }

  @override
  Future<void> removeString({
    required String suiteName,
    required String key,
  }) async {
    try {
      await _channel.invokeMethod<void>('removeString', {
        'suiteName': suiteName,
        'key': key,
      });
    } on MissingPluginException {
      return;
    } on PlatformException {
      return;
    }
  }

  @override
  Future<void> removeBool({
    required String suiteName,
    required String key,
  }) async {
    try {
      await _channel.invokeMethod<void>('removeBool', {
        'suiteName': suiteName,
        'key': key,
      });
    } on MissingPluginException {
      return;
    } on PlatformException {
      return;
    }
  }
}

/// Flutter publishes this snapshot bridge for iOS extensions/App Group readers.
///
/// Native extensions should open the App Group UserDefaults suite named by
/// [PilotPresenceStoreKeys.appGroupIdentifier] and read only
/// [PilotPresenceStoreKeys.snapshotV1]. They render this versioned payload and
/// send user actions back through app deep links or future app commands; they
/// must not write commitment state directly.
class SharedPreferencesPilotPresenceStore implements PilotPresenceStore {
  final PilotPresenceSharedStoreBridge sharedStoreBridge;

  const SharedPreferencesPilotPresenceStore({
    this.sharedStoreBridge =
        const MethodChannelPilotPresenceSharedStoreBridge(),
  });

  @override
  Future<CommitmentSnapshot?> readSnapshot() async {
    final sharedRaw = await sharedStoreBridge.readString(
      suiteName: PilotPresenceStoreKeys.appGroupIdentifier,
      key: PilotPresenceStoreKeys.snapshotV1,
    );
    final sharedSnapshot = _decodeSnapshot(sharedRaw);
    if (sharedSnapshot != null) return sharedSnapshot;

    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(PilotPresenceStoreKeys.snapshotV1);
    return _decodeSnapshot(raw);
  }

  CommitmentSnapshot? _decodeSnapshot(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      return CommitmentSnapshot.fromJson(Map<String, dynamic>.from(decoded));
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> publishSnapshot(CommitmentSnapshot snapshot) async {
    final raw = jsonEncode(snapshot.toJson());
    await sharedStoreBridge.writeString(
      suiteName: PilotPresenceStoreKeys.appGroupIdentifier,
      key: PilotPresenceStoreKeys.snapshotV1,
      value: raw,
    );

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(PilotPresenceStoreKeys.snapshotV1, raw);
  }

  @override
  Future<void> clearSnapshot() async {
    await sharedStoreBridge.removeString(
      suiteName: PilotPresenceStoreKeys.appGroupIdentifier,
      key: PilotPresenceStoreKeys.snapshotV1,
    );

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(PilotPresenceStoreKeys.snapshotV1);
  }
}
