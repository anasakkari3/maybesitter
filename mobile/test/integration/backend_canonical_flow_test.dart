import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/api/api_capture_service.dart';
import 'package:maybesitter_mobile/services/api/api_commitment_repository.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';

void main() {
  group('Backend Canonical Handoff Flow Integration Tests (Port 4321)', () {
    final baseUrl = 'http://127.0.0.1:4321';
    final scopeId = 'integration-test-${DateTime.now().millisecondsSinceEpoch}';
    final apiClient = ApiClient(baseUrl: baseUrl);
    final captureService = ApiCaptureService(
      apiClient: apiClient,
      defaultScopeId: scopeId,
    );
    final repo = ApiCommitmentRepository(apiClient: apiClient);

    test(
      'Executes 14-step canonical mobile flow against backend commit 3def247',
      () async {
        // 1. Submit capture
        final captureResult = await captureService.capture(
          CaptureRequest(
            rawInput: 'Call the dentist tomorrow at 3pm',
            capturedAt: DateTime.now(),
            scopeId: scopeId,
          ),
        );

        // 2. Verify proposal response
        expect(captureResult.proposalId, isNotNull);
        expect(captureResult.extractedCommitments.isNotEmpty, isTrue);

        final firstItemId = captureResult.extractedCommitments.first.id;

        // 3. Verify capture does not persist anything until confirmed
        final todayBefore = await repo.getToday();
        final upcomingBefore = await repo.getUpcoming();
        expect(todayBefore.any((c) => c.id == firstItemId), isFalse);
        expect(upcomingBefore.any((c) => c.id == firstItemId), isFalse);

        // 4. Confirm proposal
        final confirmResult = await captureService.confirmProposal(
          proposalId: captureResult.proposalId!,
          scopeId: scopeId,
          itemIds: [firstItemId],
        );
        expect(confirmResult.success, isTrue);
        expect(confirmResult.persisted.isNotEmpty, isTrue);

        final backendCommitmentId = confirmResult.persisted.first.commitmentId;

        // 5. Repeat confirmation and verify idempotent result
        final repeatConfirm = await captureService.confirmProposal(
          proposalId: captureResult.proposalId!,
          scopeId: scopeId,
          itemIds: [firstItemId],
        );
        expect(repeatConfirm.success, isTrue);

        // 6 & 7. Fetch Upcoming and verify persisted commitment appears
        final upcomingAfter = await repo.getUpcoming();
        expect(upcomingAfter.any((c) => c.id == backendCommitmentId), isTrue);

        // Fetch direct GET by ID
        final directRecord = await repo.getById(backendCommitmentId);
        expect(directRecord, isNotNull);
        expect(directRecord!.id, equals(backendCommitmentId));
        final originalScheduledDate = directRecord.scheduledDate;

        // 8. Complete using action endpoint (POST /api/mobile/commitments/{id}/actions)
        await repo.complete(backendCommitmentId);

        // 9 & 10. Refresh and verify state updated to completed
        final completedRecord = await repo.getById(backendCommitmentId);
        expect(completedRecord, isNotNull);
        expect(completedRecord!.status, equals(CommitmentStatus.completed));

        // 11. Verify due date and timezone did NOT change unexpectedly
        expect(completedRecord.scheduledDate, equals(originalScheduledDate));

        // 12. Soft-delete test commitment
        await repo.delete(backendCommitmentId);

        // 13. Verify it disappears from Today and Upcoming
        final todayFinal = await repo.getToday();
        final upcomingFinal = await repo.getUpcoming();
        expect(todayFinal.any((c) => c.id == backendCommitmentId), isFalse);
        expect(upcomingFinal.any((c) => c.id == backendCommitmentId), isFalse);

        // 14. Direct GET returns dropped record
        final droppedRecord = await repo.getById(backendCommitmentId);
        if (droppedRecord != null) {
          expect(droppedRecord.status, equals(CommitmentStatus.cancelled));
        }
      },
    );
  });
}
