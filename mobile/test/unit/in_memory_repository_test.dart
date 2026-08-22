import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_commitment_repository.dart';
import 'package:maybesitter_mobile/services/mock/commitment_state_store.dart';

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

    test('a newly confirmed commitment survives a relaunch', () async {
      final store = InMemoryStateStore();
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;

      final newCommitment = Commitment(
        id: 'new-1',
        title: 'Remind me to call Ahmad tomorrow at 3 PM',
        description: 'Captured via text input',
        scheduledDate: DateTime.now().add(const Duration(days: 1)),
        startTime: '10:00 AM',
        priority: CommitmentPriority.should,
        status: CommitmentStatus.pending,
        category: 'Personal',
      );
      await first.saveAll([newCommitment]);

      final relaunched = InMemoryCommitmentRepository(stateStore: store);
      await relaunched.ready;
      final restored = await relaunched.getById('new-1');

      expect(restored, isNotNull);
      expect(restored!.title, 'Remind me to call Ahmad tomorrow at 3 PM');
    });
  });
}
