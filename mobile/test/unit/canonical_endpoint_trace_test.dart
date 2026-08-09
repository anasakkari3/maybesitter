import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/services/api/api_capture_service.dart';
import 'package:maybesitter_mobile/services/api/api_commitment_repository.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('Canonical Endpoint Trace & Verification Tests', () {
    test(
      'Asserts exact REST endpoints for capture, confirm, fetch, action, and refresh',
      () async {
        final List<String> requestedPaths = [];

        final mockClient = MockClient((request) async {
          requestedPaths.add('${request.method} ${request.url.path}');

          if (request.url.path == '/api/mobile/capture') {
            return http.Response(
              '{"status":"needs_confirmation","requestId":"req-1","proposalId":"prop-1","extractedCommitments":[{"id":"c1","title":"Doc appt"}]}',
              200,
              headers: {'content-type': 'application/json'},
            );
          } else if (request.url.path == '/api/mobile/capture/confirm') {
            return http.Response(
              '{"success":true,"persisted":[{"itemId":"c1","commitmentId":"comm-1","title":"Doc appt"}],"failed":[]}',
              200,
              headers: {'content-type': 'application/json'},
            );
          } else if (request.url.path == '/api/mobile/commitments/today') {
            return http.Response(
              '{"items":[{"id":"comm-1","title":"Doc appt","status":"pending"}]}',
              200,
              headers: {'content-type': 'application/json'},
            );
          } else if (request.url.path ==
              '/api/mobile/commitments/comm-1/actions') {
            return http.Response(
              '{"success":true,"action":"complete","commitmentId":"comm-1"}',
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response('{"error":"not_found"}', 404);
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );
        final captureService = ApiCaptureService(apiClient: apiClient);
        final commitmentRepo = ApiCommitmentRepository(apiClient: apiClient);

        // 1. POST /api/mobile/capture
        await captureService.capture(
          CaptureRequest(
            rawInput: 'Doctor appointment tomorrow',
            capturedAt: DateTime.now(),
          ),
        );

        // 2. POST /api/mobile/capture/confirm
        await captureService.confirmProposal(
          proposalId: 'prop-1',
          scopeId: 'default',
          itemIds: ['c1'],
        );

        // 3. GET /api/mobile/commitments/today
        await commitmentRepo.getToday();

        // 4. POST /api/mobile/commitments/comm-1/actions (action: complete)
        await commitmentRepo.complete('comm-1');

        // Note: complete() automatically triggers refresh getToday()
        expect(requestedPaths[0], equals('POST /api/mobile/capture'));
        expect(requestedPaths[1], equals('POST /api/mobile/capture/confirm'));
        expect(requestedPaths[2], equals('GET /api/mobile/commitments/today'));
        expect(
          requestedPaths[3],
          equals('POST /api/mobile/commitments/comm-1/actions'),
        );
        expect(requestedPaths[4], equals('GET /api/mobile/commitments/today'));
      },
    );
  });
}
