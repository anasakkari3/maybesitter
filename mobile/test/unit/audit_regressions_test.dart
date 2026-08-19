/// Regressions from a manual pass on the iPhone 17 simulator.
///
/// Each test here reproduces something a person hit while using the app
/// normally, written before the fix so the failure is the evidence.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/activity_event.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/mock/commitment_state_store.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_commitment_repository.dart';
import 'package:maybesitter_mobile/services/mock/mock_activity_repository.dart';
import 'package:maybesitter_mobile/features/reminders/postpone_sheet.dart';

void main() {
  group('postpone moves a commitment forward, never backward', () {
    // Reported: "Pediatric Checkup (Leo)" on Thursday 20 August was postponed
    // by "1 Hour Later" and came back as Wednesday 19 August — a day earlier
    // than it started. The options were computed from DateTime.now() rather
    // than from the commitment, so for anything scheduled in the future
    // "one hour later" lands in its past.
    final scheduled = DateTime(2026, 8, 20, 9, 0);
    final now = DateTime(2026, 8, 19, 14, 0);

    test('one hour later is one hour after the commitment, not after now', () {
      final options = postponeOptionsFor(scheduledAt: scheduled, now: now);
      expect(options.oneHour, DateTime(2026, 8, 20, 10, 0));
    });

    test('three hours later is three hours after the commitment', () {
      final options = postponeOptionsFor(scheduledAt: scheduled, now: now);
      expect(options.threeHours, DateTime(2026, 8, 20, 12, 0));
    });

    test('tomorrow morning is the morning after the commitment', () {
      final options = postponeOptionsFor(scheduledAt: scheduled, now: now);
      expect(options.tomorrowMorning, DateTime(2026, 8, 21, 9, 0));
    });

    test('next week is a week after the commitment', () {
      final options = postponeOptionsFor(scheduledAt: scheduled, now: now);
      expect(options.nextWeek, DateTime(2026, 8, 27, 9, 0));
    });

    test('every option is strictly later than the commitment it postpones', () {
      final options = postponeOptionsFor(scheduledAt: scheduled, now: now);
      for (final option in options.all) {
        expect(
          option.date.isAfter(scheduled),
          isTrue,
          reason: '${option.labelKey} landed at ${option.date}, not after $scheduled',
        );
      }
    });

    test('an overdue commitment is postponed from now, not further into the past', () {
      // The one case where "from the commitment" is wrong: a commitment whose
      // time has already passed would otherwise be postponed to another moment
      // that is also in the past.
      final overdue = DateTime(2026, 8, 18, 9, 0);
      final options = postponeOptionsFor(scheduledAt: overdue, now: now);
      for (final option in options.all) {
        expect(
          option.date.isAfter(now),
          isTrue,
          reason: '${option.labelKey} landed at ${option.date}, not after $now',
        );
      }
    });

    test('a commitment with no scheduled date is postponed from now', () {
      final options = postponeOptionsFor(scheduledAt: null, now: now);
      expect(options.oneHour, DateTime(2026, 8, 19, 15, 0));
    });
  });

  group('activity history reflects what the user did', () {
    test('a subscriber that arrives after seeding still sees the seeded events', () async {
      // Reported: Activity showed "No Activity Yet" even though the repository
      // seeds three events in its constructor. It emitted them on a broadcast
      // controller before anything had subscribed, and a broadcast stream does
      // not replay to a late subscriber — so the screen received nothing.
      final repo = MockActivityRepository();
      final first = await repo.watchActivity().first;
      expect(first, isNotEmpty);
    });

    test('completing a commitment records it in activity', () async {
      final activity = MockActivityRepository();
      final repo = InMemoryCommitmentRepository(activityRepository: activity);
      final before = (await activity.getActivity()).length;

      final target = (await repo.getToday()).first;
      await repo.complete(target.id);

      final events = await activity.getActivity();
      expect(events.length, before + 1);
      expect(events.first.type, ActivityEventType.commitmentCompleted);
      expect(events.first.description, contains(target.title));
    });

    test('postponing a commitment records it in activity', () async {
      final activity = MockActivityRepository();
      final repo = InMemoryCommitmentRepository(activityRepository: activity);
      final before = (await activity.getActivity()).length;

      final target = (await repo.getToday()).first;
      await repo.postpone(target.id, DateTime(2026, 8, 21, 9, 0));

      final events = await activity.getActivity();
      expect(events.length, before + 1);
      expect(events.first.type, ActivityEventType.commitmentPostponed);
      expect(events.first.description, contains(target.title));
    });
  });

  group('what the user did survives a relaunch', () {
    test('a completed commitment is still completed in a fresh repository', () async {
      // Reported: completing every commitment produced the "No Commitments
      // Today" empty state; after terminating and relaunching, the app was
      // back to "3 commitments remaining for today".
      final store = InMemoryStateStore();
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;
      final target = (await first.getToday()).first;
      await first.complete(target.id);

      final relaunched = InMemoryCommitmentRepository(stateStore: store);
      await relaunched.ready;
      final restored = (await relaunched.getToday())
          .firstWhere((commitment) => commitment.id == target.id);

      expect(restored.status, CommitmentStatus.completed);
    });

    test('a postponed date survives a relaunch', () async {
      final store = InMemoryStateStore();
      final newDate = DateTime(2026, 8, 21, 9, 0);
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;
      final target = (await first.getToday()).first;
      await first.postpone(target.id, newDate);

      final relaunched = InMemoryCommitmentRepository(stateStore: store);
      await relaunched.ready;
      // Postponing moved it off today, which is the point — look wherever it
      // landed rather than where it used to be.
      final restored = [
        ...await relaunched.getToday(),
        ...await relaunched.getUpcoming(),
      ].firstWhere((commitment) => commitment.id == target.id);

      expect(restored.status, CommitmentStatus.postponed);
      expect(restored.scheduledDate, newDate);
    });
  });
}
