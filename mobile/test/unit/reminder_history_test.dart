import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/services/api/dtos/activity_dtos.dart';
import 'package:maybesitter_mobile/services/api/mappers/reminder_history_mapper.dart';

void main() {
  group('Reminder History Grouping & Privacy Tests', () {
    test(
      'Failed attempt followed by successful retry collapses into 1 successful event',
      () {
        final attempts = [
          const ReminderAttemptDto(
            id: 'att-1',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'failed',
            idempotencyKey: 'secret-idemp-1',
            scheduledFor: '2026-07-29T10:00:00.000Z',
            attemptNumber: 1,
            error: 'Connection timeout internal trace 0x88',
          ),
          const ReminderAttemptDto(
            id: 'att-2',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'sent',
            idempotencyKey: 'secret-idemp-2',
            scheduledFor: '2026-07-29T10:00:00.000Z',
            attemptNumber: 2,
          ),
        ];

        final events = ReminderHistoryMapper.groupAttempts(attempts);
        expect(events.length, equals(1));
        expect(events.first.title, contains('Push'));
        expect(events.first.description, contains('delivered successfully'));
        expect(events.first.description, isNot(contains('secret-idemp')));
        expect(events.first.description, isNot(contains('0x88')));
      },
    );

    test(
      'Multiple failed attempts collapse into 1 user-facing failed event',
      () {
        final attempts = [
          const ReminderAttemptDto(
            id: 'att-1',
            itemId: 'item-101',
            type: 'reminder',
            channel: 'sms',
            status: 'failed',
            idempotencyKey: 'idemp-x',
            scheduledFor: '2026-07-29T12:00:00.000Z',
            attemptNumber: 1,
            error: 'Internal Gateway Timeout 504',
          ),
          const ReminderAttemptDto(
            id: 'att-2',
            itemId: 'item-101',
            type: 'reminder',
            channel: 'sms',
            status: 'failed',
            idempotencyKey: 'idemp-y',
            scheduledFor: '2026-07-29T12:00:00.000Z',
            attemptNumber: 2,
            error: 'Max retries exhausted',
          ),
        ];

        final events = ReminderHistoryMapper.groupAttempts(attempts);
        expect(events.length, equals(1));
        expect(events.first.title, contains('SMS'));
        expect(events.first.description, contains('failed to deliver'));
        expect(events.first.description, isNot(contains('504')));
      },
    );

    test('Two separate reminders for the same commitment remain separate', () {
      final attempts = [
        const ReminderAttemptDto(
          id: 'att-1',
          itemId: 'item-100',
          type: 'reminder',
          channel: 'push',
          status: 'sent',
          idempotencyKey: 'idemp-1',
          scheduledFor: '2026-07-29T09:00:00.000Z',
          attemptNumber: 1,
        ),
        const ReminderAttemptDto(
          id: 'att-2',
          itemId: 'item-100',
          type: 'reminder',
          channel: 'push',
          status: 'sent',
          idempotencyKey: 'idemp-2',
          scheduledFor: '2026-07-29T17:00:00.000Z',
          attemptNumber: 1,
        ),
      ];

      final events = ReminderHistoryMapper.groupAttempts(attempts);
      expect(events.length, equals(2));
    });

    test(
      'Unknown status and unknown channel have safe localized fallback representations',
      () {
        final attempts = [
          const ReminderAttemptDto(
            id: 'att-unk',
            itemId: 'item-999',
            type: 'reminder',
            channel: 'unknown_custom_channel',
            status: 'future_status_code',
            idempotencyKey: 'idemp-z',
            scheduledFor: '2026-07-29T15:00:00.000Z',
          ),
        ];

        final events = ReminderHistoryMapper.groupAttempts(attempts);
        expect(events.length, equals(1));
        expect(events.first.title, contains('Notification'));
        expect(events.first.description, isNot(contains('future_status_code')));
      },
    );
  });
}
