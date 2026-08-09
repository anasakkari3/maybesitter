import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/commitment.dart';

void main() {
  group('Commitment Model Tests', () {
    test('toJson and fromJson serialization', () {
      final now = DateTime.now();
      final commitment = Commitment(
        id: 'test-1',
        title: 'Go to the doctor',
        description: 'Checkup',
        scheduledDate: now,
        startTime: '09:00 AM',
        priority: CommitmentPriority.must,
        status: CommitmentStatus.pending,
      );

      final json = commitment.toJson();
      final restored = Commitment.fromJson(json);

      expect(restored.id, 'test-1');
      expect(restored.title, 'Go to the doctor');
      expect(restored.priority, CommitmentPriority.must);
      expect(restored.status, CommitmentStatus.pending);
    });

    test('copyWith updates specific fields correctly', () {
      final commitment = Commitment(
        id: 'test-1',
        title: 'Original Title',
        scheduledDate: DateTime.now(),
      );

      final updated = commitment.copyWith(
        title: 'Updated Title',
        status: CommitmentStatus.completed,
      );

      expect(updated.title, 'Updated Title');
      expect(updated.status, CommitmentStatus.completed);
      expect(updated.id, 'test-1');
    });
  });
}
