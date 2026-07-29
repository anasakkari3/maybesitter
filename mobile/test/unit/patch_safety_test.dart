import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';
import 'package:maybesitter_mobile/services/api/api_commitment_repository.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('PATCH Safety & Data-Integrity Guard Tests', () {
    test(
      '1. AppConfig.supportsSafeCommitmentPatch is false in localBackend and true in mock mode',
      () {
        const mockConfig = AppConfig(apiMode: ApiMode.mock);
        expect(mockConfig.supportsSafeCommitmentPatch, isTrue);

        const realConfig = AppConfig(apiMode: ApiMode.localBackend);
        expect(realConfig.supportsSafeCommitmentPatch, isFalse);
      },
    );

    test(
      '2. ApiCommitmentRepository.update throws UnsupportedError in real API mode',
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
        final repo = ApiCommitmentRepository(apiClient: apiClient);

        const testCommitment = Commitment(
          id: 'comm-100',
          title: 'Doctor Appointment',
          scheduledDate: null,
        );

        expect(
          () async => await repo.update(testCommitment),
          throwsA(isA<UnsupportedError>()),
        );

        // Verify ZERO HTTP PATCH requests were emitted
        expect(
          requestedMethods.contains('PATCH /api/mobile/commitments/comm-100'),
          isFalse,
        );
        expect(requestedMethods, isEmpty);
      },
    );

    test(
      '3. Complete, postpone, cancel, getToday, and soft-delete remain functional in ApiCommitmentRepository',
      () async {
        final List<String> requestedPaths = [];
        final mockClient = MockClient((request) async {
          requestedPaths.add('${request.method} ${request.url.path}');
          if (request.url.path == '/api/mobile/commitments/today') {
            return http.Response(
              '{"items":[]}',
              200,
              headers: {'content-type': 'application/json'},
            );
          } else if (request.url.path.contains('/actions')) {
            return http.Response(
              '{"success":true}',
              200,
              headers: {'content-type': 'application/json'},
            );
          } else if (request.method == 'DELETE') {
            return http.Response(
              '{"success":true,"softDeleted":true,"id":"comm-1"}',
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response('{}', 200);
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );
        final repo = ApiCommitmentRepository(apiClient: apiClient);

        // Complete
        await repo.complete('comm-1');
        // Postpone
        await repo.postpone(
          'comm-1',
          DateTime.now().add(const Duration(days: 1)),
        );
        // Cancel
        await repo.cancel('comm-1');
        // Soft Delete
        await repo.delete('comm-1');

        expect(
          requestedPaths,
          contains('POST /api/mobile/commitments/comm-1/actions'),
        );
        expect(
          requestedPaths,
          contains('DELETE /api/mobile/commitments/comm-1'),
        );
      },
    );
  });
}
