import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';
import 'package:maybesitter_mobile/services/api/api_commitment_repository.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('PATCH Capability & Fine-Grained Payload Exact Request Tests', () {
    test(
      '1. AppConfig capability resolution: mock mode enabled, real backend requires explicit ENABLE_SAFE_COMMITMENT_PATCH',
      () {
        const mockConfig = AppConfig(apiMode: ApiMode.mock);
        expect(mockConfig.supportsSafeCommitmentPatch, isTrue);

        const realDisabled = AppConfig(
          apiMode: ApiMode.localBackend,
          enableSafeCommitmentPatch: false,
        );
        expect(realDisabled.supportsSafeCommitmentPatch, isFalse);

        const realEnabled = AppConfig(
          apiMode: ApiMode.localBackend,
          enableSafeCommitmentPatch: true,
        );
        expect(realEnabled.supportsSafeCommitmentPatch, isTrue);
      },
    );

    test(
      '2. Disabled capability: ApiCommitmentRepository update rejected safely without sending HTTP PATCH',
      () async {
        final List<String> requestedMethods = [];
        final mockClient = MockClient((request) async {
          requestedMethods.add('${request.method} ${request.url.path}');
          return http.Response('{"status":"ok"}', 200);
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );
        final repo = ApiCommitmentRepository(
          apiClient: apiClient,
          supportsSafeCommitmentPatch: false,
        );

        const testCommitment = Commitment(
          id: 'comm-100',
          title: 'Doctor Appointment',
        );

        expect(
          () async => await repo.update(testCommitment),
          throwsA(isA<UnsupportedError>()),
        );

        expect(requestedMethods, isEmpty);
      },
    );

    test(
      '3. Enabled capability: Title-only PATCH sends ONLY title field and no replacement timeSpec',
      () async {
        Map<String, dynamic>? capturedBody;
        final mockClient = MockClient((request) async {
          if (request.method == 'PATCH') {
            capturedBody = jsonDecode(request.body) as Map<String, dynamic>;
            return http.Response(
              '{"status":"ok"}',
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            '{"items":[]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );
        final repo = ApiCommitmentRepository(
          apiClient: apiClient,
          supportsSafeCommitmentPatch: true,
        );

        await repo.patchFields('comm-1', title: 'Updated Title');

        expect(capturedBody, isNotNull);
        expect(capturedBody!.keys, equals(['title']));
        expect(capturedBody!['title'], equals('Updated Title'));
        expect(capturedBody!.containsKey('timeSpec'), isFalse);
        expect(capturedBody!.containsKey('dueDate'), isFalse);
        expect(capturedBody!.containsKey('reminderTime'), isFalse);
      },
    );

    test(
      '4. Enabled capability: Description-only PATCH sends ONLY description field',
      () async {
        Map<String, dynamic>? capturedBody;
        final mockClient = MockClient((request) async {
          if (request.method == 'PATCH') {
            capturedBody = jsonDecode(request.body) as Map<String, dynamic>;
            return http.Response(
              '{"status":"ok"}',
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            '{"items":[]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );
        final repo = ApiCommitmentRepository(
          apiClient: apiClient,
          supportsSafeCommitmentPatch: true,
        );

        await repo.patchFields('comm-1', description: 'Updated Description');

        expect(capturedBody, isNotNull);
        expect(capturedBody!.keys, equals(['description']));
        expect(capturedBody!['description'], equals('Updated Description'));
      },
    );

    test(
      '5. Enabled capability: Priority-only PATCH sends ONLY priority field',
      () async {
        Map<String, dynamic>? capturedBody;
        final mockClient = MockClient((request) async {
          if (request.method == 'PATCH') {
            capturedBody = jsonDecode(request.body) as Map<String, dynamic>;
            return http.Response(
              '{"status":"ok"}',
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            '{"items":[]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );
        final repo = ApiCommitmentRepository(
          apiClient: apiClient,
          supportsSafeCommitmentPatch: true,
        );

        await repo.patchFields('comm-1', priority: 'high');

        expect(capturedBody, isNotNull);
        expect(capturedBody!.keys, equals(['priority']));
        expect(capturedBody!['priority'], equals('high'));
      },
    );

    test(
      '6. Enabled capability: Date-only PATCH sends ONLY supported dueDate field',
      () async {
        Map<String, dynamic>? capturedBody;
        final mockClient = MockClient((request) async {
          if (request.method == 'PATCH') {
            capturedBody = jsonDecode(request.body) as Map<String, dynamic>;
            return http.Response(
              '{"status":"ok"}',
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            '{"items":[]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );
        final repo = ApiCommitmentRepository(
          apiClient: apiClient,
          supportsSafeCommitmentPatch: true,
        );

        await repo.patchFields('comm-1', dueDate: '2026-07-30T15:00:00.000Z');

        expect(capturedBody, isNotNull);
        expect(capturedBody!.keys, equals(['dueDate']));
        expect(capturedBody!['dueDate'], equals('2026-07-30T15:00:00.000Z'));
      },
    );

    test(
      '7. Enabled capability: Reminder-only PATCH sends ONLY supported reminderTime field',
      () async {
        Map<String, dynamic>? capturedBody;
        final mockClient = MockClient((request) async {
          if (request.method == 'PATCH') {
            capturedBody = jsonDecode(request.body) as Map<String, dynamic>;
            return http.Response(
              '{"status":"ok"}',
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            '{"items":[]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );
        final repo = ApiCommitmentRepository(
          apiClient: apiClient,
          supportsSafeCommitmentPatch: true,
        );

        await repo.patchFields(
          'comm-1',
          reminderTime: '2026-07-30T14:30:00.000Z',
        );

        expect(capturedBody, isNotNull);
        expect(capturedBody!.keys, equals(['reminderTime']));
        expect(
          capturedBody!['reminderTime'],
          equals('2026-07-30T14:30:00.000Z'),
        );
      },
    );
  });
}
