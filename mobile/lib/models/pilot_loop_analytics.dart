import 'package:flutter/foundation.dart';

import '../config/app_config.dart';

enum PilotLoopAnalyticsEventName {
  voiceCaptureStarted('voice_capture_started'),
  voiceCaptureCompleted('voice_capture_completed'),
  voiceCaptureAbandoned('voice_capture_abandoned'),
  widgetImpression('widget_impression'),
  widgetTap('widget_tap'),
  deepLinkOpened('deep_link_opened');

  final String wireName;

  const PilotLoopAnalyticsEventName(this.wireName);
}

@immutable
class PilotLoopAnalyticsEvent {
  static final _privateKey = RegExp(
    r'(raw|message|text|title|description|person|email|phone|prompt|content)',
    caseSensitive: false,
  );

  final PilotLoopAnalyticsEventName name;
  final Map<String, Object?> properties;

  const PilotLoopAnalyticsEvent({required this.name, required this.properties});

  factory PilotLoopAnalyticsEvent.voiceCaptureStarted({
    required String source,
    required String locale,
    required PilotPresenceFeatureFlags flags,
  }) {
    return PilotLoopAnalyticsEvent(
      name: PilotLoopAnalyticsEventName.voiceCaptureStarted,
      properties: {
        'source': source,
        'locale': locale,
        ...flagProperties(flags),
      },
    );
  }

  factory PilotLoopAnalyticsEvent.voiceCaptureCompleted({
    required String source,
    required String locale,
    required int inputLength,
    required PilotPresenceFeatureFlags flags,
  }) {
    return PilotLoopAnalyticsEvent(
      name: PilotLoopAnalyticsEventName.voiceCaptureCompleted,
      properties: {
        'source': source,
        'locale': locale,
        'inputLength': inputLength,
        ...flagProperties(flags),
      },
    );
  }

  factory PilotLoopAnalyticsEvent.voiceCaptureAbandoned({
    required String source,
    required String locale,
    required String reason,
    required int inputLength,
    required PilotPresenceFeatureFlags flags,
  }) {
    return PilotLoopAnalyticsEvent(
      name: PilotLoopAnalyticsEventName.voiceCaptureAbandoned,
      properties: {
        'source': source,
        'locale': locale,
        'reason': reason,
        'inputLength': inputLength,
        ...flagProperties(flags),
      },
    );
  }

  factory PilotLoopAnalyticsEvent.widgetImpression({
    required String surface,
    required String widgetFamily,
    required String widgetState,
    required PilotPresenceFeatureFlags flags,
  }) {
    return PilotLoopAnalyticsEvent(
      name: PilotLoopAnalyticsEventName.widgetImpression,
      properties: {
        'surface': surface,
        'widgetFamily': widgetFamily,
        'widgetState': widgetState,
        ...flagProperties(flags),
      },
    );
  }

  factory PilotLoopAnalyticsEvent.widgetTap({
    required String surface,
    required String targetRoute,
    required PilotPresenceFeatureFlags flags,
  }) {
    return PilotLoopAnalyticsEvent(
      name: PilotLoopAnalyticsEventName.widgetTap,
      properties: {
        'surface': surface,
        'targetRoute': targetRoute,
        ...flagProperties(flags),
      },
    );
  }

  factory PilotLoopAnalyticsEvent.deepLinkOpened({
    required String source,
    required String targetRoute,
    required PilotPresenceFeatureFlags flags,
  }) {
    return PilotLoopAnalyticsEvent(
      name: PilotLoopAnalyticsEventName.deepLinkOpened,
      properties: {
        'source': source,
        'targetRoute': targetRoute,
        ...flagProperties(flags),
      },
    );
  }

  static Map<String, Object?> flagProperties(PilotPresenceFeatureFlags flags) {
    return {
      'flagWidget': flags.widget,
      'flagVoice': flags.voice,
      'flagAwareness': flags.awareness,
      'flagWatch': flags.watch,
      'flagImports': flags.imports,
    };
  }

  Map<String, dynamic> toJson() {
    _validatePrivacySafe();
    return {'eventName': name.wireName, 'properties': properties};
  }

  void _validatePrivacySafe() {
    for (final entry in properties.entries) {
      if (_privateKey.hasMatch(entry.key)) {
        throw ArgumentError('Private analytics property is forbidden');
      }
      final value = entry.value;
      if (value != null &&
          value is! String &&
          value is! num &&
          value is! bool) {
        throw ArgumentError('Analytics properties must be scalar');
      }
      if (value is String && value.length > 128) {
        throw ArgumentError('Analytics property is too long');
      }
      if (entry.key == 'targetRoute' &&
          !const {'capture', 'today', 'commitment_detail'}.contains(value)) {
        throw ArgumentError('Analytics target route is not canonical');
      }
      if (entry.key == 'source' &&
          !const {'app', 'widget', 'external'}.contains(value)) {
        throw ArgumentError('Analytics source is not canonical');
      }
    }
  }
}
