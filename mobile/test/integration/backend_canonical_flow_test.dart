import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/api/api_capture_service.dart';
import 'package:maybesitter_mobile/services/api/api_commitment_repository.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';

void main() {
  group('Backend Canonical 87408da Integration Flow Tests (Port 4321)', () {
    final baseUrl = 'http://127.0.0.1:4321';
    final scopeId = 'integration-test-${DateTime.now().millisecondsSinceEpoch}';
    final apiClient = ApiClient(baseUrl: baseUrl);
    final captureService = ApiCaptureService(
      apiClient: apiClient,
      defaultScopeId: scopeId,
    );
    final repo = ApiCommitmentRepository(
      apiClient: apiClient,
      supportsSafeCommitmentPatch: true,
    );

    test(
      'Executes 17-step extended canonical mobile flow with safe PATCH against backend commit 87408da',
      () async {
        // 1. Capture a deterministic verb-led commitment
        final captureResult = await captureService.capture(
          CaptureRequest(
            rawInput: 'Call the dentist tomorrow at 3pm',
            capturedAt: DateTime.now(),
            scopeId: scopeId,
          ),
        );

        // 2. Confirm it
        expect(captureResult.proposalId, isNotNull);
        final firstItemId = captureResult.extractedCommitments.first.id;

        final confirmResult = await captureService.confirmProposal(
          proposalId: captureResult.proposalId!,
          scopeId: scopeId,
          itemIds: [firstItemId],
        );
        expect(confirmResult.success, isTrue);
        final backendCommitmentId = confirmResult.persisted.first.commitmentId;

        // 3. Retrieve it from Upcoming / Direct GET
        final initialRecord = await repo.getById(backendCommitmentId);
        expect(initialRecord, isNotNull);

        // 4. Record initial time fields from backend
        final rawJsonBefore = await apiClient.get(
          '/api/mobile/commitments/$backendCommitmentId',
        );
        final rawTimeSpecBefore =
            rawJsonBefore['timeSpec'] as Map<String, dynamic>;
        final initialDueAt = rawTimeSpecBefore['dueAt'];
        final initialRemindAt = rawTimeSpecBefore['remindAt'];
        final initialTimezone = rawTimeSpecBefore['timezone'];
        final initialKind = rawTimeSpecBefore['kind'];

        // 5. Perform title-only PATCH
        await repo.patchFields(
          backendCommitmentId,
          title: 'Call dentist urgent',
        );

        // 6. Verify title changed
        final afterTitleRecord = await repo.getById(backendCommitmentId);
        expect(afterTitleRecord!.title, equals('Call dentist urgent'));

        // 7. Verify all four recorded time fields remain IDENTICAL
        final rawJsonAfterTitle = await apiClient.get(
          '/api/mobile/commitments/$backendCommitmentId',
        );
        final rawTimeSpecAfterTitle =
            rawJsonAfterTitle['timeSpec'] as Map<String, dynamic>;
        expect(rawTimeSpecAfterTitle['dueAt'], equals(initialDueAt));
        expect(rawTimeSpecAfterTitle['remindAt'], equals(initialRemindAt));
        expect(rawTimeSpecAfterTitle['timezone'], equals(initialTimezone));
        expect(rawTimeSpecAfterTitle['kind'], equals(initialKind));

        // 8. Perform description-only PATCH
        await repo.patchFields(
          backendCommitmentId,
          description: 'Dr. Smith office line',
        );

        // 9. Verify time fields remain IDENTICAL
        final rawJsonAfterDesc = await apiClient.get(
          '/api/mobile/commitments/$backendCommitmentId',
        );
        final rawTimeSpecAfterDesc =
            rawJsonAfterDesc['timeSpec'] as Map<String, dynamic>;
        expect(rawTimeSpecAfterDesc['dueAt'], equals(initialDueAt));
        expect(rawTimeSpecAfterDesc['remindAt'], equals(initialRemindAt));
        expect(rawTimeSpecAfterDesc['timezone'], equals(initialTimezone));
        expect(rawTimeSpecAfterDesc['kind'], equals(initialKind));

        // 10. Perform priority-only PATCH
        await repo.patchFields(backendCommitmentId, priority: 'high');

        // 11. Verify time fields remain IDENTICAL
        final rawJsonAfterPriority = await apiClient.get(
          '/api/mobile/commitments/$backendCommitmentId',
        );
        final rawTimeSpecAfterPriority =
            rawJsonAfterPriority['timeSpec'] as Map<String, dynamic>;
        expect(rawTimeSpecAfterPriority['dueAt'], equals(initialDueAt));
        expect(rawTimeSpecAfterPriority['remindAt'], equals(initialRemindAt));
        expect(rawTimeSpecAfterPriority['timezone'], equals(initialTimezone));
        expect(rawTimeSpecAfterPriority['kind'], equals(initialKind));

        // 12. Perform one explicit supported date/reminder update
        const newDueDate = '2026-07-30T16:00:00.000Z';
        await repo.patchFields(backendCommitmentId, dueDate: newDueDate);

        // 13. Verify returned instant matches contract semantics
        final rawJsonAfterDate = await apiClient.get(
          '/api/mobile/commitments/$backendCommitmentId',
        );
        final rawTimeSpecAfterDate =
            rawJsonAfterDate['timeSpec'] as Map<String, dynamic>;
        expect(rawTimeSpecAfterDate['dueAt'], isNotNull);
        expect(rawTimeSpecAfterDate['timezone'], equals(initialTimezone));

        // 14. Perform complete or postpone
        await repo.complete(backendCommitmentId);

        // 15. Refresh and verify state
        final completedRecord = await repo.getById(backendCommitmentId);
        expect(completedRecord!.status, equals(CommitmentStatus.completed));

        // 16. Soft-delete test record
        await repo.delete(backendCommitmentId);

        // 17. Verify cleanup behavior
        final todayAfterDelete = await repo.getToday();
        final upcomingAfterDelete = await repo.getUpcoming();
        expect(
          todayAfterDelete.any((c) => c.id == backendCommitmentId),
          isFalse,
        );
        expect(
          upcomingAfterDelete.any((c) => c.id == backendCommitmentId),
          isFalse,
        );

        final droppedRecord = await repo.getById(backendCommitmentId);
        if (droppedRecord != null) {
          expect(droppedRecord.status, equals(CommitmentStatus.cancelled));
        }
      },
    );
  });
}
