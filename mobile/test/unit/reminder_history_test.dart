import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/services/api/dtos/activity_dtos.dart';
import 'package:maybesitter_mobile/services/api/mappers/reminder_history_mapper.dart';

void main() {
  group('Reminder History Identity & Collapsing Policy Tests', () {
    test(
      '1. Two attempts with the SAME idempotencyKey are NOT merged by default (enableIdentityCollapsing = false)',
      () {
        final attempts = [
          const ReminderAttemptDto(
            id: 'att-1',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'failed',
            idempotencyKey: 'same-idemp-key-123',
            scheduledFor: '2026-07-29T10:00:00.000Z',
            attemptNumber: 1,
          ),
          const ReminderAttemptDto(
            id: 'att-2',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'sent',
            idempotencyKey: 'same-idemp-key-123',
            scheduledFor: '2026-07-29T10:00:00.000Z',
            attemptNumber: 2,
          ),
        ];

        final eventsDefault = ReminderHistoryMapper.groupAttempts(attempts);
        expect(eventsDefault.length, equals(2));
      },
    );

    test(
      '2. When enableIdentityCollapsing = true, attempts sharing idempotencyKey merge into 1 event',
      () {
        final attempts = [
          const ReminderAttemptDto(
            id: 'att-1',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'failed',
            idempotencyKey: 'same-idemp-key-123',
            scheduledFor: '2026-07-29T10:00:00.000Z',
            attemptNumber: 1,
          ),
          const ReminderAttemptDto(
            id: 'att-2',
            itemId: 'item-100',
            type: 'reminder',
            channel: 'push',
            status: 'sent',
            idempotencyKey: 'same-idemp-key-123',
            scheduledFor: '2026-07-29T10:00:00.000Z',
            attemptNumber: 2,
          ),
        ];

        final eventsCollapsed = ReminderHistoryMapper.groupAttempts(
          attempts,
          enableIdentityCollapsing: true,
        );
        expect(eventsCollapsed.length, equals(1));
        expect(
          eventsCollapsed.first.description,
          contains('delivered successfully'),
        );
      },
    );

    test(
      '3. Ordering remains deterministic sorted by timestamp descending',
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
      '4. Internal fields (errors, idempotencyKeys, escalation levels) remain hidden',
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
