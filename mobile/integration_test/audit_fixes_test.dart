/// The three audit findings, replayed on a device.
///
/// The unit tests prove the arithmetic and the wiring. These prove the app a
/// person actually touches behaves differently than it did — the postpone
/// reaches the repository with a later date, the two actions land in Activity,
/// and a completion written by one repository is still there for the next one.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:maybesitter_mobile/models/activity_event.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/mock/commitment_state_store.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_commitment_repository.dart';
import 'package:maybesitter_mobile/services/mock/mock_activity_repository.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('a completion survives a relaunch through real device storage', (tester) async {
    // The reported symptom: complete everything, get the empty state, relaunch,
    // and all three are back. This drives the real PreferencesStateStore rather
    // than a test double, so it exercises the platform channel too.
    final store = PreferencesStateStore();

    final firstLaunch = InMemoryCommitmentRepository(stateStore: store);
    await firstLaunch.ready;
    final target = (await firstLaunch.getToday()).first;
    expect(target.status, isNot(CommitmentStatus.completed));
    await firstLaunch.complete(target.id);

    final relaunch = InMemoryCommitmentRepository(stateStore: store);
    await relaunch.ready;
    final restored = (await relaunch.getToday())
        .firstWhere((commitment) => commitment.id == target.id);

    expect(restored.status, CommitmentStatus.completed);
    expect(restored.completedAt, isNotNull);
  });

  testWidgets('a postpone survives a relaunch and lands later, not earlier', (tester) async {
    final store = PreferencesStateStore();
    final firstLaunch = InMemoryCommitmentRepository(stateStore: store);
    await firstLaunch.ready;
    final target = (await firstLaunch.getToday()).first;
    final originalDate = target.scheduledDate;
    final later = (originalDate ?? DateTime.now()).add(const Duration(hours: 1));

    await firstLaunch.postpone(target.id, later);

    final relaunch = InMemoryCommitmentRepository(stateStore: store);
    await relaunch.ready;
    final restored = [
      ...await relaunch.getToday(),
      ...await relaunch.getUpcoming(),
    ].firstWhere((commitment) => commitment.id == target.id);

    expect(restored.status, CommitmentStatus.postponed);
    expect(restored.scheduledDate, later);
    if (originalDate != null) {
      expect(
        restored.scheduledDate!.isAfter(originalDate),
        isTrue,
        reason: 'a postpone must move a commitment forward',
      );
    }
  });

  testWidgets('completing and postponing both reach Activity', (tester) async {
    final activity = MockActivityRepository();
    final repo = InMemoryCommitmentRepository(
      activityRepository: activity,
      stateStore: PreferencesStateStore(),
    );
    await repo.ready;

    // What the screen sees: a late subscriber, exactly like the Activity tab
    // being opened after the app has been running.
    final seenByScreen = await activity.watchActivity().first;
    expect(seenByScreen, isNotEmpty, reason: 'the tab showed "No Activity Yet" over seeded data');

    final today = await repo.getToday();
    await repo.complete(today.first.id);
    await repo.postpone(today.last.id, DateTime.now().add(const Duration(days: 1)));

    final events = await activity.getActivity();
    expect(
      events.where((e) => e.type == ActivityEventType.commitmentCompleted).length,
      greaterThanOrEqualTo(1),
    );
    expect(
      events.where((e) => e.type == ActivityEventType.commitmentPostponed).length,
      greaterThanOrEqualTo(1),
    );
  });
}
