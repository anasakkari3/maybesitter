/// The capture screen now reads what was typed.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/rule_based_capture_service.dart';

void main() {
  test('three intentions come back as three proposals', () async {
    final result = await RuleBasedCaptureService(
      now: () => DateTime(2026, 8, 21, 12),
    ).capture(
      CaptureRequest(
        rawInput: 'بكرة الصبح بدي أنزل على الشغل على الخمسة '
            'لازم أكون بالنادي على السبعة',
        capturedAt: DateTime(2026, 8, 21, 12),
      ),
    );

    expect(result.extractedCommitments, hasLength(2));
    expect(result.extractedCommitments.first.startTime, '05:00');
    expect(result.extractedCommitments.last.priority, CommitmentPriority.must);
  });

  test('the user confirms before anything is saved', () async {
    final result = await RuleBasedCaptureService().capture(
      CaptureRequest(
        rawInput: 'لازم أتصل بأحمد بكرة',
        capturedAt: DateTime(2026, 8, 21, 12),
      ),
    );

    expect(result.status, CaptureStatus.needsConfirmation);
  });

  test('text with nothing in it proposes nothing', () async {
    final result = await RuleBasedCaptureService().capture(
      CaptureRequest(rawInput: '   ', capturedAt: DateTime(2026, 8, 21, 12)),
    );

    expect(result.extractedCommitments, isEmpty);
  });
}
