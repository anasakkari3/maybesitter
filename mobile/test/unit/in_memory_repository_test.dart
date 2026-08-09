import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_commitment_repository.dart';

void main() {
  group('InMemoryCommitmentRepository Tests', () {
    late InMemoryCommitmentRepository repo;

    setUp(() {
      repo = InMemoryCommitmentRepository();
    });

    test('Initial seeded data contains today and upcoming items', () async {
      final today = await repo.getToday();
      final upcoming = await repo.getUpcoming();

      expect(today, isNotEmpty);
      expect(upcoming, isNotEmpty);
    });

    test('Completing a commitment updates status', () async {
      final today = await repo.getToday();
      final target = today.first;

      await repo.complete(target.id);
      final updated = await repo.getById(target.id);

      expect(updated?.status, CommitmentStatus.completed);
    });

    test('Postponing a commitment updates date', () async {
      final today = await repo.getToday();
      final target = today.first;
      final futureDate = DateTime.now().add(const Duration(days: 5));

      await repo.postpone(target.id, futureDate);
      final updated = await repo.getById(target.id);

      expect(updated?.scheduledDate, futureDate);
      expect(updated?.status, CommitmentStatus.postponed);
    });
  });
}
