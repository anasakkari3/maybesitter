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

  group('Commitment.copyWith end time', () {
    final base = Commitment(
      id: 'c-1',
      title: 'Briefing',
      scheduledDate: DateTime(2026, 8, 23, 10, 30),
      startTime: '10:30 AM',
      endTime: '11:15 AM',
      priority: CommitmentPriority.must,
      status: CommitmentStatus.pending,
      category: 'Home',
    );

    test('clearEndTime removes an end time copyWith cannot otherwise drop', () {
      expect(base.copyWith(clearEndTime: true).endTime, isNull);
    });

    test('an unrelated copyWith still preserves the end time', () {
      expect(base.copyWith(title: 'Renamed').endTime, '11:15 AM');
    });

    test('setting a new end time still wins over clearing nothing', () {
      expect(base.copyWith(endTime: '12:00 PM').endTime, '12:00 PM');
    });
  });
}
