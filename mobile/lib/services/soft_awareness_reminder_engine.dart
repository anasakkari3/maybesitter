import '../config/app_config.dart';
import '../models/activity_event.dart';
import '../models/commitment.dart';
import '../models/pilot_loop_analytics.dart';
import '../models/pilot_presence.dart';
import 'contracts/activity_repository.dart';
import 'contracts/awareness_state_store.dart';
import 'contracts/commitment_repository.dart';
import 'contracts/notification_service.dart';
import 'contracts/pilot_loop_analytics_service.dart';

sealed class SoftAwarenessCommand {
  final String commitmentId;
  final DateTime occurredAt;
  final String? notificationId;

  const SoftAwarenessCommand({
    required this.commitmentId,
    required this.occurredAt,
    this.notificationId,
  });

  Map<String, dynamic> toJson();

  Map<String, dynamic> baseJson(String type) {
    return {
      'type': type,
      'commitmentId': commitmentId,
      'occurredAt': occurredAt.toUtc().toIso8601String(),
      if (notificationId != null) 'notificationId': notificationId,
    };
  }
}

class MarkAwareNotificationCommand extends SoftAwarenessCommand {
  const MarkAwareNotificationCommand({
    required super.commitmentId,
    required super.occurredAt,
    super.notificationId,
  });

  @override
  Map<String, dynamic> toJson() => baseJson('mark_aware');
}

class SnoozeNotificationCommand extends SoftAwarenessCommand {
  final DateTime snoozedUntil;
  final ReminderIntensity intensity;

  const SnoozeNotificationCommand({
    required super.commitmentId,
    required super.occurredAt,
    required this.snoozedUntil,
    this.intensity = ReminderIntensity.softAwareness,
    super.notificationId,
  });

  @override
  Map<String, dynamic> toJson() => {
    ...baseJson('snooze'),
    'snoozedUntil': snoozedUntil.toUtc().toIso8601String(),
  };
}

class DoneNotificationCommand extends SoftAwarenessCommand {
  const DoneNotificationCommand({
    required super.commitmentId,
    required super.occurredAt,
    super.notificationId,
  });

  @override
  Map<String, dynamic> toJson() => baseJson('done');
}

class IgnoreNotificationCommand extends SoftAwarenessCommand {
  const IgnoreNotificationCommand({
    required super.commitmentId,
    required super.occurredAt,
    super.notificationId,
  });

  @override
  Map<String, dynamic> toJson() => baseJson('ignore');
}

class MissedNotificationCommand extends SoftAwarenessCommand {
  const MissedNotificationCommand({
    required super.commitmentId,
    required super.occurredAt,
    super.notificationId,
  });

  @override
  Map<String, dynamic> toJson() => baseJson('missed');
}

class SoftAwarenessReminderEngine {
  final NotificationService notificationService;
  final ReminderPolicy Function() reminderPolicy;
  final UserRoutineProfile? Function() routineProfile;
  final bool Function() notificationsEnabled;
  final PilotPresenceFeatureFlags Function() flags;
  final AwarenessStateStore awarenessStateStore;
  final DateTime Function() now;
  final Set<String> _scheduledCommitmentIds = <String>{};

  SoftAwarenessReminderEngine({
    required this.notificationService,
    required this.reminderPolicy,
    required this.routineProfile,
    required this.notificationsEnabled,
    required this.flags,
    required this.awarenessStateStore,
    DateTime Function()? now,
  }) : now = now ?? DateTime.now;

  Future<void> syncCommitments(List<Commitment> commitments) async {
    final trackedIds = commitments.map((commitment) => commitment.id).toSet();
    final awarenessFlags = flags();
    final permission = await notificationService.permissionState();
    if (!awarenessFlags.awareness ||
        !notificationsEnabled() ||
        permission != NotificationPermissionState.granted) {
      await _cancelAll({...trackedIds, ..._scheduledCommitmentIds});
      return;
    }

    final nextScheduledIds = <String>{};
    final policy = reminderPolicy();
    final profile = routineProfile();

    // An acknowledgement only means anything while its commitment is still
    // live. Drop the rest so a recycled id can never inherit stale awareness.
    await awarenessStateStore.retainOnly(trackedIds);

    for (final commitment in commitments) {
      final requests = await _requestsFor(
        commitment,
        policy: policy,
        profile: profile,
      );
      if (requests.isEmpty) {
        await notificationService.cancelFor(commitment.id);
        continue;
      }
      for (final request in requests) {
        await notificationService.schedule(request);
      }
      nextScheduledIds.add(commitment.id);
    }

    for (final commitmentId in _scheduledCommitmentIds.difference(
      nextScheduledIds,
    )) {
      await notificationService.cancelFor(commitmentId);
    }

    _scheduledCommitmentIds
      ..clear()
      ..addAll(nextScheduledIds);
  }

  /// Every notification still owed for [commitment], soft stage first.
  Future<List<ScheduledNotificationRequest>> _requestsFor(
    Commitment commitment, {
    required ReminderPolicy policy,
    required UserRoutineProfile? profile,
  }) async {
    if (commitment.status.isCompleted ||
        commitment.status == CommitmentStatus.cancelled) {
      return const [];
    }

    final scheduledStart = _scheduledStartFor(commitment);
    if (scheduledStart == null) return const [];

    final plan = policy.planFor(commitment);
    if (plan.isEmpty) return const [];

    // Acknowledgement answers the whole sequence. The soft stage is what
    // earned it, and every escalation after that stage exists only because
    // awareness was missing -- so once the user says they know, nothing in the
    // plan is still owed. The commitment stays pending: they know, not done.
    if (await awarenessStateStore.isAware(commitment.id)) return const [];

    final requests = <ScheduledNotificationRequest>[];
    for (final stage in plan.stages) {
      final scheduledAt = scheduledStart.subtract(stage.leadTime);
      if (!scheduledAt.isAfter(now())) continue;
      if (stage.respectsQuietHours &&
          _isWithinQuietHours(scheduledAt, profile)) {
        continue;
      }

      requests.add(
        ScheduledNotificationRequest(
          notificationId: notificationIdFor(
            commitmentId: commitment.id,
            intensity: stage.intensity,
          ),
          commitmentId: commitment.id,
          scheduledAt: scheduledAt,
          intensity: stage.intensity,
        ),
      );
    }
    return requests;
  }

  /// A notification id that depends only on the commitment and the stage.
  ///
  /// Re-syncing must land on the same id so the platform replaces a pending
  /// notification instead of stacking a duplicate beside it.
  static String notificationIdFor({
    required String commitmentId,
    required ReminderIntensity intensity,
  }) => 'soft-awareness-$commitmentId-${intensity.name}';

  DateTime? _scheduledStartFor(Commitment commitment) {
    final scheduledDate = commitment.scheduledDate;
    if (scheduledDate == null) return null;

    final parsedClock = _parseTimeOfDay(commitment.startTime);
    if (parsedClock != null) {
      return DateTime(
        scheduledDate.year,
        scheduledDate.month,
        scheduledDate.day,
        parsedClock.hour,
        parsedClock.minute,
      );
    }

    if (commitment.timeGranularity == TimeGranularity.exact ||
        commitment.timeGranularity == TimeGranularity.timeRange) {
      if (scheduledDate.hour != 0 ||
          scheduledDate.minute != 0 ||
          scheduledDate.second != 0 ||
          scheduledDate.millisecond != 0 ||
          scheduledDate.microsecond != 0) {
        return scheduledDate;
      }
    }

    return null;
  }

  bool _isWithinQuietHours(DateTime when, UserRoutineProfile? profile) {
    final windows = <RoutineTimeWindow>[
      if (profile?.quietHours != null) profile!.quietHours!,
      if (profile?.sleepWindow != null) profile!.sleepWindow!,
    ];
    for (final window in windows) {
      if (_windowContains(window, when)) return true;
    }
    return false;
  }

  bool _windowContains(RoutineTimeWindow window, DateTime when) {
    final start = _parseTimeOfDay(window.start);
    final end = _parseTimeOfDay(window.end);
    if (start == null || end == null) return false;

    final minuteOfDay = when.hour * 60 + when.minute;
    final startMinutes = start.hour * 60 + start.minute;
    final endMinutes = end.hour * 60 + end.minute;

    if (startMinutes == endMinutes) return true;
    if (startMinutes < endMinutes) {
      return minuteOfDay >= startMinutes && minuteOfDay < endMinutes;
    }
    return minuteOfDay >= startMinutes || minuteOfDay < endMinutes;
  }

  _ClockTime? _parseTimeOfDay(String? raw) {
    if (raw == null || raw.trim().isEmpty) return null;
    final normalized = raw.trim().toUpperCase();
    final meridiemMatch = RegExp(
      r'^(\d{1,2}):(\d{2})\s*([AP]M)$',
    ).firstMatch(normalized);
    if (meridiemMatch != null) {
      final hour = int.parse(meridiemMatch.group(1)!);
      final minute = int.parse(meridiemMatch.group(2)!);
      final meridiem = meridiemMatch.group(3)!;
      if (hour > 12 || minute > 59) return null;
      final normalizedHour = switch (meridiem) {
        'AM' => hour == 12 ? 0 : hour,
        'PM' => hour == 12 ? 12 : hour + 12,
        _ => hour,
      };
      return _ClockTime(normalizedHour, minute);
    }

    final twentyFourHourMatch = RegExp(
      r'^(\d{1,2}):(\d{2})$',
    ).firstMatch(normalized);
    if (twentyFourHourMatch == null) return null;
    final hour = int.parse(twentyFourHourMatch.group(1)!);
    final minute = int.parse(twentyFourHourMatch.group(2)!);
    if (hour > 23 || minute > 59) return null;
    return _ClockTime(hour, minute);
  }

  Future<void> _cancelAll(Set<String> commitmentIds) async {
    for (final commitmentId in commitmentIds) {
      await notificationService.cancelFor(commitmentId);
    }
    _scheduledCommitmentIds.clear();
  }
}

class SoftAwarenessCommandDispatcher {
  final CommitmentRepository commitmentRepository;
  final NotificationService notificationService;
  final ActivityRepository activityRepository;
  final AwarenessStateStore awarenessStateStore;
  final PilotLoopAnalyticsService? analyticsService;
  final PilotPresenceFeatureFlags flags;

  const SoftAwarenessCommandDispatcher({
    required this.commitmentRepository,
    required this.notificationService,
    required this.activityRepository,
    required this.awarenessStateStore,
    this.analyticsService,
    required this.flags,
  });

  Future<void> dispatch(SoftAwarenessCommand command) async {
    switch (command) {
      case MarkAwareNotificationCommand():
        // Awareness is recorded, never inferred, and never mistaken for done.
        await awarenessStateStore.markAware(
          command.commitmentId,
          command.occurredAt,
        );
        await notificationService.cancelFor(command.commitmentId);
        await _recordActivity(
          type: ActivityEventType.softAwarenessAcknowledged,
          commitmentId: command.commitmentId,
          occurredAt: command.occurredAt,
          description: 'A soft awareness reminder was acknowledged.',
        );
        await _recordAction('aware');
        break;
      case SnoozeNotificationCommand():
        await notificationService.schedule(
          ScheduledNotificationRequest(
            notificationId:
                command.notificationId ??
                'soft-awareness-${command.commitmentId}-${command.snoozedUntil.toUtc().millisecondsSinceEpoch}',
            commitmentId: command.commitmentId,
            scheduledAt: command.snoozedUntil,
            intensity: command.intensity,
          ),
        );
        await _recordActivity(
          type: ActivityEventType.softAwarenessSnoozed,
          commitmentId: command.commitmentId,
          occurredAt: command.occurredAt,
          description: 'A soft awareness reminder was snoozed.',
        );
        await _recordAction('snooze');
        break;
      case DoneNotificationCommand():
        await notificationService.cancelFor(command.commitmentId);
        await awarenessStateStore.clear(command.commitmentId);
        await commitmentRepository.complete(command.commitmentId);
        await _recordAction('done');
        break;
      case IgnoreNotificationCommand():
        await notificationService.cancelFor(command.commitmentId);
        await _recordActivity(
          type: ActivityEventType.softAwarenessIgnored,
          commitmentId: command.commitmentId,
          occurredAt: command.occurredAt,
          description:
              'A soft awareness reminder was ignored and recorded without blame.',
        );
        await _recordMissed('ignored');
        break;
      case MissedNotificationCommand():
        await notificationService.cancelFor(command.commitmentId);
        await _recordActivity(
          type: ActivityEventType.softAwarenessMissed,
          commitmentId: command.commitmentId,
          occurredAt: command.occurredAt,
          description:
              'A soft awareness reminder passed without acknowledgement and was recorded without blame.',
        );
        await _recordMissed('missed');
        break;
    }
  }

  Future<void> _recordAction(String action) async {
    try {
      await analyticsService?.record(
        PilotLoopAnalyticsEvent.softAwarenessAction(
          action: action,
          flags: flags,
        ),
      );
    } catch (_) {}
  }

  Future<void> _recordMissed(String outcome) async {
    try {
      await analyticsService?.record(
        PilotLoopAnalyticsEvent.softAwarenessMissed(
          outcome: outcome,
          flags: flags,
        ),
      );
    } catch (_) {}
  }

  Future<void> _recordActivity({
    required ActivityEventType type,
    required String commitmentId,
    required DateTime occurredAt,
    required String description,
  }) {
    return activityRepository.logEvent(
      ActivityEvent(
        id: 'soft-awareness-${type.name}-$commitmentId-${occurredAt.toUtc().microsecondsSinceEpoch}',
        type: type,
        title: type.defaultTitle,
        description: description,
        timestamp: occurredAt,
        relatedCommitmentId: commitmentId,
        iconName: 'notification',
      ),
    );
  }
}

class _ClockTime {
  final int hour;
  final int minute;

  const _ClockTime(this.hour, this.minute);
}
