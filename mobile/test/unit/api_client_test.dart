import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:maybesitter_mobile/services/api/api_capture_service.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';
import 'package:maybesitter_mobile/services/api/api_commitment_repository.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';

void main() {
  group('ApiClient & API Services Integration Tests', () {
    test('POST /api/mobile/capture returns proposal response', () async {
      final mockClient = MockClient((request) async {
        expect(request.url.path, equals('/api/mobile/capture'));
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        expect(body['text'], equals('Doctor at 9am'));
        expect(body['scopeId'], equals('default'));

        return http.Response(
          jsonEncode({
            'proposalId': 'prop-123',
            'status': 'proposed',
            'items': [
              {
                'itemId': 'item-10',
                'title': 'Doctor visit',
                'resolvedTime': '2026-07-29T09:00:00.000Z',
                'needsClarification': false,
              },
            ],
          }),
          200,
        );
      });

      final apiClient = ApiClient(
        baseUrl: 'http://localhost:3000',
        client: mockClient,
      );
      final service = ApiCaptureService(apiClient: apiClient);

      final result = await service.capture(
        CaptureRequest(
          rawInput: 'Doctor at 9am',
          capturedAt: DateTime.utc(2026, 7, 28, 10, 0),
        ),
      );

      expect(result.status, equals(CaptureStatus.needsConfirmation));
      expect(result.extractedCommitments.length, equals(1));
      expect(result.extractedCommitments[0].title, equals('Doctor visit'));
    });

    test(
      'POST /api/mobile/capture/confirm submits itemIds and receives confirmation',
      () async {
        final mockClient = MockClient((request) async {
          expect(request.url.path, equals('/api/mobile/capture/confirm'));
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          expect(body['proposalId'], equals('prop-123'));
          expect(body['itemIds'], equals(['item-10']));

          return http.Response(
            jsonEncode({
              'success': true,
              'persisted': [
                {
                  'itemId': 'item-10',
                  'commitmentId': 'cid-10',
                  'title': 'Doctor visit',
                  'resolvedTime': '2026-07-29T09:00:00.000Z',
                },
              ],
              'failed': [],
            }),
            200,
          );
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );
        final service = ApiCaptureService(apiClient: apiClient);

        final response = await service.confirmProposal(
          proposalId: 'prop-123',
          scopeId: 'default',
          itemIds: ['item-10'],
        );

        expect(response.success, isTrue);
        expect(response.persisted.length, equals(1));
        expect(response.persisted[0].commitmentId, equals('cid-10'));
      },
    );

    test(
      'GET /api/mobile/commitments/today retrieves mapped commitments',
      () async {
        final mockClient = MockClient((request) async {
          expect(request.url.path, equals('/api/mobile/commitments/today'));

          return http.Response(
            jsonEncode({
              'items': [
                {
                  'id': 'c-today-1',
                  'title': 'Morning Yoga',
                  'status': 'active',
                  'priority': {'level': 'normal'},
                  'timeSpec': {
                    'kind': 'scheduled_event',
                    'dueAt': '2026-07-28T07:00:00.000Z',
                  },
                  'createdAt': '2026-07-28T06:00:00.000Z',
                  'updatedAt': '2026-07-28T06:00:00.000Z',
                },
              ],
            }),
            200,
          );
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );
        final repo = ApiCommitmentRepository(apiClient: apiClient);

        final todayItems = await repo.getToday();
        expect(todayItems.length, equals(1));
        expect(todayItems[0].id, equals('c-today-1'));
        expect(todayItems[0].title, equals('Morning Yoga'));
      },
    );

    test('DELETE /api/mobile/commitments/{id} executes soft delete', () async {
      final mockClient = MockClient((request) async {
        if (request.method == 'DELETE') {
          expect(request.url.path, equals('/api/mobile/commitments/del-1'));
          return http.Response(
            jsonEncode({
              'success': true,
              'id': 'del-1',
              'deleted': false,
              'softDeleted': true,
              'status': 'dropped',
            }),
            200,
          );
        }
        return http.Response(jsonEncode({'items': []}), 200);
      });

      final apiClient = ApiClient(
        baseUrl: 'http://localhost:3000',
        client: mockClient,
      );
      final repo = ApiCommitmentRepository(apiClient: apiClient);

      expect(repo.delete('del-1'), completes);
    });

    test('ApiCommitmentRepository saveAll throws UnsupportedError', () async {
      final apiClient = ApiClient(baseUrl: 'http://localhost:3000');
      final repo = ApiCommitmentRepository(apiClient: apiClient);

      expect(() => repo.saveAll([]), throwsA(isA<UnsupportedError>()));
    });

    test(
      'Maps HTTP 400 to ValidationException and 503 to ServerException',
      () async {
        final mockClient = MockClient((request) async {
          if (request.url.path.contains('bad')) {
            return http.Response(
              jsonEncode({'error': 'Malformed JSON text'}),
              400,
            );
          }
          return http.Response(
            jsonEncode({'error': 'Production API guarded'}),
            503,
          );
        });

        final apiClient = ApiClient(
          baseUrl: 'http://localhost:3000',
          client: mockClient,
        );

        expect(
          () => apiClient.get('/bad'),
          throwsA(isA<ValidationException>()),
        );
        expect(
          () => apiClient.get('/guarded'),
          throwsA(isA<ServerException>()),
        );
      },
    );
  });
}
