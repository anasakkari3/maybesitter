import 'package:flutter/services.dart';

import '../core/platform/platform_adaptive.dart';

/// Sends the phone's snapshot to a paired Apple Watch.
///
/// The widget reads the App Group directly; a watch cannot, because App Groups
/// do not cross between an iPhone and an Apple Watch. This carries the same
/// payload over WatchConnectivity so both surfaces render one decision made in
/// one place.
abstract interface class WatchSnapshotBridge {
  Future<bool> isSupported();

  /// Returns false when there is no watch to receive it, so a caller can tell
  /// "nothing paired" from "sent" rather than assuming success.
  Future<bool> publishSnapshot(String json);

  Future<bool> clearSnapshot();

  /// What the platform says about the watch link, for diagnosing a refusal.
  Future<Map<String, Object?>> diagnostics();
}

class MethodChannelWatchSnapshotBridge implements WatchSnapshotBridge {
  static const _channel = MethodChannel(
    'com.maybesitter.mobile/watch_snapshot_bridge',
  );

  const MethodChannelWatchSnapshotBridge();

  @override
  Future<bool> isSupported() async {
    if (!PlatformAdaptive.isIOS) return false;
    try {
      return await _channel.invokeMethod<bool>('isSupported') ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<Map<String, Object?>> diagnostics() async {
    if (!PlatformAdaptive.isIOS) return const {'supported': false};
    try {
      final raw = await _channel.invokeMapMethod<String, Object?>('diagnostics');
      return raw ?? const {};
    } on PlatformException {
      return const {};
    } on MissingPluginException {
      return const {};
    }
  }

  @override
  Future<bool> publishSnapshot(String json) => _invoke('publishSnapshot', json);

  @override
  Future<bool> clearSnapshot() => _invoke('clearSnapshot', null);

  Future<bool> _invoke(String method, Object? arguments) async {
    if (!PlatformAdaptive.isIOS) return false;
    try {
      return await _channel.invokeMethod<bool>(method, arguments) ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      // No watch bridge on this build is a missing surface, not a failure of
      // the phone's own presence.
      return false;
    }
  }
}
