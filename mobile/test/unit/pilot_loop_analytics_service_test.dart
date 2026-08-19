import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/pilot_loop_analytics.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';
import 'package:maybesitter_mobile/services/api/api_pilot_loop_analytics_service.dart';

void main() {
  group('PilotLoopAnalyticsEvent', () {
    test('serializes content-free voice and widget events', () {
      const flags = PilotPresenceFeatureFlags(
        widget: true,
        voice: true,
        awareness: false,
        watch: false,
        imports: false,
      );

      final event = PilotLoopAnalyticsEvent.voiceCaptureCompleted(
        source: 'widget',
        locale: 'en-US',
        inputLength: 42,
        flags: flags,
      ).toJson();

      expect(event['eventName'], 'voice_capture_completed');
      expect(event['properties'], {
        'source': 'widget',
        'locale': 'en-US',
        'inputLength': 42,
        'flagWidget': true,
        'flagVoice': true,
        'flagAwareness': false,
        'flagWatch': false,
        'flagImports': false,
      });
      expect(jsonEncode(event), isNot(contains('raw')));
      expect(jsonEncode(event), isNot(contains('title')));
    });

    test('rejects private analytics keys before network send', () {
      expect(
        () => const PilotLoopAnalyticsEvent(
          name: PilotLoopAnalyticsEventName.voiceCaptureCompleted,
          properties: {'rawText': 'call Maya'},
        ).toJson(),
        throwsArgumentError,
      );
    });
  });

  group('ApiPilotLoopAnalyticsService', () {
    test(
      'posts bearer-authenticated analytics without participant id',
      () async {
        late http.Request sent;
        final service = ApiPilotLoopAnalyticsService(
          apiClient: ApiClient(
            baseUrl: 'http://localhost:3000',
            authTokenProvider: () async => 'pilot-token',
            client: MockClient((request) async {
              sent = request;
              return http.Response('{"success":true,"recorded":true}', 200);
            }),
          ),
        );

        await service.record(
          PilotLoopAnalyticsEvent.widgetTap(
            surface: 'homeWidget',
            targetRoute: '/capture?source=widget&input=voice',
            flags: const PilotPresenceFeatureFlags(
              widget: true,
              voice: true,
              awareness: false,
              watch: false,
              imports: false,
            ),
          ),
        );

        expect(sent.method, 'POST');
        expect(sent.url.path, ApiPilotLoopAnalyticsService.path);
        expect(sent.headers['authorization'], 'Bearer pilot-token');
        final body = jsonDecode(sent.body) as Map<String, dynamic>;
        expect(body['eventName'], 'widget_tap');
        expect(body.containsKey('participantId'), isFalse);
        expect(body.containsKey('anonymousUserId'), isFalse);
      },
    );
  });
}
