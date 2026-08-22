import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_commitment_repository.dart';
import 'package:maybesitter_mobile/services/mock/commitment_state_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

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

    test('a newly confirmed commitment survives JSON serialization through SharedPreferences', () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      SharedPreferences.setMockInitialValues({});

      final store = PreferencesStateStore();
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;

      final scheduledDate = DateTime.now().add(const Duration(days: 1));
      final newCommitment = Commitment(
        id: 'new-json-1',
        title: 'Remind me to call Ahmad tomorrow at 3 PM',
        description: 'Captured via text input',
        scheduledDate: scheduledDate,
        startTime: '10:00 AM',
        priority: CommitmentPriority.should,
        status: CommitmentStatus.pending,
        category: 'Personal',
      );
      await first.saveAll([newCommitment]);

      // Create a new repository instance with the same SharedPreferences backing
      final relaunched = PreferencesStateStore();
      final secondRepo = InMemoryCommitmentRepository(stateStore: relaunched);
      await secondRepo.ready;
      final restored = await secondRepo.getById('new-json-1');

      expect(restored, isNotNull);
      expect(restored!.title, 'Remind me to call Ahmad tomorrow at 3 PM');
      expect(restored!.description, 'Captured via text input');
      expect(restored!.startTime, '10:00 AM');
      expect(restored!.priority, CommitmentPriority.should);
      expect(restored!.category, 'Personal');
      expect(restored!.status, CommitmentStatus.pending);
    });
  });

  group('what the user changed survives a relaunch', () {
    test('an edited title on a seeded commitment survives', () async {
      final store = InMemoryStateStore();
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;
      final target = (await first.getToday()).first;

      await first.update(target.copyWith(title: 'Renamed by the user'));

      final relaunched = InMemoryCommitmentRepository(stateStore: store);
      await relaunched.ready;
      expect((await relaunched.getById(target.id))?.title, 'Renamed by the user');
    });

    test('an edited start time on a seeded commitment survives', () async {
      final store = InMemoryStateStore();
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;
      final target = (await first.getToday()).first;

      await first.update(target.copyWith(startTime: '11:45 PM'));

      final relaunched = InMemoryCommitmentRepository(stateStore: store);
      await relaunched.ready;
      expect((await relaunched.getById(target.id))?.startTime, '11:45 PM');
    });

    test('a deleted seeded commitment does not come back', () async {
      final store = InMemoryStateStore();
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;
      final target = (await first.getToday()).first;

      await first.delete(target.id);

      final relaunched = InMemoryCommitmentRepository(stateStore: store);
      await relaunched.ready;
      expect(
        await relaunched.getById(target.id),
        isNull,
        reason: 'a commitment the user deleted reappeared after relaunch',
      );
    });

    test('a cancelled seeded commitment stays cancelled', () async {
      final store = InMemoryStateStore();
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;
      final target = (await first.getToday()).first;

      await first.cancel(target.id);
      final expected = (await first.getById(target.id))?.status;

      final relaunched = InMemoryCommitmentRepository(stateStore: store);
      await relaunched.ready;
      expect((await relaunched.getById(target.id))?.status, expected);
    });

    test('a title containing the fingerprint delimiter is still distinguishable', () async {
      // A naive "join fields with |" fingerprint would let a crafted title
      // impersonate a different field layout and read as unmodified.
      final store = InMemoryStateStore();
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;
      final target = (await first.getToday()).first;

      await first.update(target.copyWith(title: 'a|b|c|${target.startTime}'));

      final relaunched = InMemoryCommitmentRepository(stateStore: store);
      await relaunched.ready;
      expect((await relaunched.getById(target.id))?.title, 'a|b|c|${target.startTime}');
    });
  });
}
