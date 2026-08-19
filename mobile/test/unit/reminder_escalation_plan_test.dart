import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';

Commitment _commitment({
  required CommitmentPriority priority,
  String id = 'c1',
}) {
  return Commitment(
    id: id,
    title: 'Doctor appointment',
    priority: priority,
    status: CommitmentStatus.pending,
    scheduledDate: DateTime(2026, 8, 20),
    startTime: '15:00',
    timeGranularity: TimeGranularity.exact,
  );
}

void main() {
  group('ReminderPolicy.planFor escalation sequence', () {
    test(
      'a must commitment is reminded softly first and escalated later',
      () {
        const policy = ReminderPolicy(
          maxIntensity: ReminderIntensity.strongReminder,
          strongRemindersRequireExplicitOptIn: false,
        );

        final plan = policy.planFor(
          _commitment(priority: CommitmentPriority.must),
        );

        expect(
          plan.stages.map((stage) => stage.intensity),
          [
            ReminderIntensity.softAwareness,
            ReminderIntensity.strongReminder,
          ],
        );
        expect(plan.stages.first.leadTime, const Duration(hours: 1));
        expect(plan.stages.last.leadTime, const Duration(minutes: 10));
      },
    );

    test('escalation stages fire strictly closer to the event than the soft stage', () {
      const policy = ReminderPolicy(
        maxIntensity: ReminderIntensity.strongReminder,
        strongRemindersRequireExplicitOptIn: false,
      );

      final plan = policy.planFor(
        _commitment(priority: CommitmentPriority.must),
      );

      for (var i = 1; i < plan.stages.length; i++) {
        expect(
          plan.stages[i].leadTime < plan.stages[i - 1].leadTime,
          isTrue,
          reason: 'stage $i must be closer to the event than stage ${i - 1}',
        );
      }
    });

    test('a nice commitment never escalates past soft awareness', () {
      const policy = ReminderPolicy(
        maxIntensity: ReminderIntensity.strongReminder,
        strongRemindersRequireExplicitOptIn: false,
      );

      final plan = policy.planFor(
        _commitment(priority: CommitmentPriority.nice),
      );

      expect(plan.stages.map((stage) => stage.intensity), [
        ReminderIntensity.softAwareness,
      ]);
    });

    test('a should commitment follows up but never uses a strong reminder', () {
      const policy = ReminderPolicy(
        maxIntensity: ReminderIntensity.strongReminder,
        strongRemindersRequireExplicitOptIn: false,
      );

      final plan = policy.planFor(
        _commitment(priority: CommitmentPriority.should),
      );

      expect(plan.stages.map((stage) => stage.intensity), [
        ReminderIntensity.softAwareness,
        ReminderIntensity.followUp,
      ]);
    });

    test('a must commitment stops at soft awareness without strong opt-in', () {
      const policy = ReminderPolicy(
        maxIntensity: ReminderIntensity.strongReminder,
        strongRemindersRequireExplicitOptIn: true,
      );

      final plan = policy.planFor(
        _commitment(priority: CommitmentPriority.must),
      );

      expect(
        plan.stages.map((stage) => stage.intensity),
        isNot(contains(ReminderIntensity.strongReminder)),
      );
    });

    test('maxIntensity caps the whole sequence, not just the first stage', () {
      const policy = ReminderPolicy(
        maxIntensity: ReminderIntensity.softAwareness,
        strongRemindersRequireExplicitOptIn: false,
      );

      final plan = policy.planFor(
        _commitment(priority: CommitmentPriority.must),
      );

      expect(plan.stages.map((stage) => stage.intensity), [
        ReminderIntensity.softAwareness,
      ]);
    });

    test('an intensity of none produces no stages at all', () {
      const policy = ReminderPolicy(maxIntensity: ReminderIntensity.none);

      final plan = policy.planFor(
        _commitment(priority: CommitmentPriority.must),
      );

      expect(plan.stages, isEmpty);
    });

    test('the opening stage is not an escalation, the later one is', () {
      const policy = ReminderPolicy(
        maxIntensity: ReminderIntensity.strongReminder,
        strongRemindersRequireExplicitOptIn: false,
      );

      final plan = policy.planFor(
        _commitment(priority: CommitmentPriority.must),
      );

      expect(plan.stages.first.isEscalation, isFalse);
      expect(plan.stages.last.isEscalation, isTrue);
      expect(plan.escalationStages.map((stage) => stage.intensity), [
        ReminderIntensity.strongReminder,
      ]);
    });
  });
}
