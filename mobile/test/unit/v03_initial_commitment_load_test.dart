import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_commitment_repository.dart';
import 'package:maybesitter_mobile/services/providers.dart';

void main() {
  test(
    'commitments are available on a cold launch, before any mutation',
    () async {
      // Regression guard for the defect that made the V03 loop undemonstrable
      // on a device: the repository stream is a broadcast stream with no
      // replay, so without priming the first value never arrives and Today
      // renders empty forever.
      final container = ProviderContainer(
        overrides: [
          commitmentRepositoryProvider.overrideWithValue(
            InMemoryCommitmentRepository(),
          ),
        ],
      );
      addTearDown(container.dispose);

      final commitments = await container.read(
        commitmentsStreamProvider.future,
      );

      expect(commitments, isNotEmpty);
      expect(
        commitments.map((commitment) => commitment.id).toSet().length,
        commitments.length,
        reason: 'today and upcoming overlap must not be double-counted',
      );
    },
  );

  test('later mutations still flow through the stream', () async {
    final repository = InMemoryCommitmentRepository();
    final container = ProviderContainer(
      overrides: [
        commitmentRepositoryProvider.overrideWithValue(repository),
      ],
    );
    addTearDown(container.dispose);

    // Subscribe first and keep the subscription open: the provider restarts
    // its async* body on a fresh listen, so mutating before it has reached the
    // watch phase would race.
    final updates = <List<Commitment>>[];
    final subscription = container.listen(
      commitmentsStreamProvider,
      (_, next) {
        final value = next.value;
        if (value != null) updates.add(value);
      },
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    final initial = await container.read(commitmentsStreamProvider.future);
    final target = initial.firstWhere(
      (commitment) => !commitment.status.isCompleted,
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    updates.clear();

    await repository.complete(target.id);
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(updates, isNotEmpty);
    expect(
      updates.last
          .firstWhere((commitment) => commitment.id == target.id)
          .status
          .isCompleted,
      isTrue,
    );
  });
}
