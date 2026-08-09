import '../../../models/activity_event.dart';
import '../dtos/activity_dtos.dart';

class ReminderHistoryMapper {
  /// Converts raw ReminderAttemptDto records into user-facing ActivityEvents.
  /// [enableIdentityCollapsing] is false by default pending explicit backend identity handoff.
  /// When false, each attempt is presented conservatively without merging.
  static List<ActivityEvent> groupAttempts(
    List<ReminderAttemptDto> attempts, {
    bool enableIdentityCollapsing = false,
  }) {
    if (attempts.isEmpty) return [];

    final Map<String, List<ReminderAttemptDto>> grouped = {};

    for (final attempt in attempts) {
      final key =
          (enableIdentityCollapsing && attempt.idempotencyKey.trim().isNotEmpty)
          ? 'key_${attempt.idempotencyKey.trim()}'
          : 'id_${attempt.id}';
      grouped.putIfAbsent(key, () => []).add(attempt);
    }

    final List<ActivityEvent> result = [];

    grouped.forEach((key, group) {
      group.sort((a, b) => a.attemptNumber.compareTo(b.attemptNumber));

      final first = group.first;
      final hasSuccess = group.any(
        (a) =>
            a.status.toLowerCase() == 'sent' ||
            a.status.toLowerCase() == 'delivered',
      );
      final String channelName = _formatChannel(first.channel);
      final String safeStatusText = hasSuccess
          ? 'delivered successfully'
          : 'failed to deliver';

      final String title = 'Reminder ($channelName)';
      final String description = 'Notification $safeStatusText.';

      DateTime eventTime;
      try {
        eventTime = DateTime.parse(first.scheduledFor);
      } catch (_) {
        eventTime = DateTime.now();
      }

      result.add(
        ActivityEvent(
          id: 'rem-${first.id}',
          type: ActivityEventType.commitmentCreated,
          title: title,
          description: description,
          timestamp: eventTime,
        ),
      );
    });

    // Deterministic ordering: sorted by timestamp descending
    result.sort((a, b) => b.timestamp.compareTo(a.timestamp));
    return result;
  }

  static String _formatChannel(String channel) {
    switch (channel.toLowerCase()) {
      case 'push':
        return 'Push';
      case 'sms':
        return 'SMS';
      case 'email':
        return 'Email';
      default:
        return 'Notification';
    }
  }
}
