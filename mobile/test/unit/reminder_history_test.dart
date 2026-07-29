import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/services/api/dtos/activity_dtos.dart';
import 'package:maybesitter_mobile/services/api/mappers/reminder_history_mapper.dart';

void main() {
  group('Reminder History Identity & Grouping Closure Tests', () {
    test(
      '1. Two reminders with same item and scheduled time are NOT merged without a backend idempotencyKey',
      () {
        final attempts = [
          const ReminderAttemptDto(
            id: 'att-1',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'sent',
            idempotencyKey: '',
            scheduledFor: '2026-07-29T10:00:00.000Z',
            attemptNumber: 1,
          ),
          const ReminderAttemptDto(
            id: 'att-2',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'sent',
            idempotencyKey: '',
            scheduledFor: '2026-07-29T10:00:00.000Z',
            attemptNumber: 1,
          ),
        ];

        final events = ReminderHistoryMapper.groupAttempts(attempts);
        expect(events.length, equals(2));
      },
    );

    test(
      '2. Retry records are merged ONLY when they share backend idempotencyKey',
      () {
        final attempts = [
          const ReminderAttemptDto(
            id: 'att-1',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'failed',
            idempotencyKey: 'retry-group-key-1',
            scheduledFor: '2026-07-29T10:00:00.000Z',
            attemptNumber: 1,
            error: 'Connection timeout',
          ),
          const ReminderAttemptDto(
            id: 'att-2',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'sent',
            idempotencyKey: 'retry-group-key-1',
            scheduledFor: '2026-07-29T10:00:00.000Z',
            attemptNumber: 2,
          ),
        ];

        final events = ReminderHistoryMapper.groupAttempts(attempts);
        expect(events.length, equals(1));
        expect(events.first.description, contains('delivered successfully'));
      },
    );

    test(
      '3. Different channels are not merged when idempotencyKeys differ',
      () {
        final attempts = [
          const ReminderAttemptDto(
            id: 'att-1',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'sent',
            idempotencyKey: 'push-key',
            scheduledFor: '2026-07-29T10:00:00.000Z',
          ),
          const ReminderAttemptDto(
            id: 'att-2',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'sms',
            status: 'sent',
            idempotencyKey: 'sms-key',
            scheduledFor: '2026-07-29T10:00:00.000Z',
          ),
        ];

        final events = ReminderHistoryMapper.groupAttempts(attempts);
        expect(events.length, equals(2));
        expect(events.any((e) => e.title.contains('Push')), isTrue);
        expect(events.any((e) => e.title.contains('SMS')), isTrue);
      },
    );

    test(
      '4. Ordering remains deterministic sorted by timestamp descending',
      () {
        final attempts = [
          const ReminderAttemptDto(
            id: 'att-old',
            itemId: 'item-1',
            type: 'reminder',
            channel: 'push',
            status: 'sent',
            idempotencyKey: 'k-old',
            scheduledFor: '2026-07-29T08:00:00.000Z',
          ),
          const ReminderAttemptDto(
            id: 'att-new',
            itemId: 'item-2',
            type: 'reminder',
            channel: 'push',
            status: 'sent',
            idempotencyKey: 'k-new',
            scheduledFor: '2026-07-29T16:00:00.000Z',
          ),
        ];

        final events = ReminderHistoryMapper.groupAttempts(attempts);
        expect(events.length, equals(2));
        expect(events[0].timestamp.isAfter(events[1].timestamp), isTrue);
      },
    );

    test(
      '5. Internal fields (errors, keys, escalation levels) remain hidden from UI text',
      () {
        final attempts = [
          const ReminderAttemptDto(
            id: 'att-secret',
            itemId: 'item-secret',
            type: 'reminder',
            channel: 'push',
            status: 'failed',
            idempotencyKey: 'secret_idempotency_key_123',
            scheduledFor: '2026-07-29T12:00:00.000Z',
            escalationLevel: 3,
            error: 'Sensitive internal stacktrace line 44',
          ),
        ];

        final events = ReminderHistoryMapper.groupAttempts(attempts);
        expect(events.first.title, isNot(contains('secret_idempotency')));
        expect(events.first.description, isNot(contains('secret_idempotency')));
        expect(events.first.description, isNot(contains('stacktrace')));
        expect(events.first.description, isNot(contains('escalationLevel')));
      },
    );
  });
}
