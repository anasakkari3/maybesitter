import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/notification_payload.dart';

void main() {
  group('payload round trip', () {
    test('a scheduled notification survives encode and decode', () {
      const payload = NotificationPayload(
        commitmentId: 'c1',
        notificationId: 'soft-awareness-c1-softAwareness',
        intensity: ReminderIntensity.strongReminder,
      );

      final decoded = NotificationPayload.decode(payload.encode());

      expect(decoded, isNotNull);
      expect(decoded!.commitmentId, 'c1');
      expect(decoded.notificationId, 'soft-awareness-c1-softAwareness');
      expect(decoded.intensity, ReminderIntensity.strongReminder);
    });

    test('an id containing separator characters survives intact', () {
      const payload = NotificationPayload(
        commitmentId: 'c:1|weird',
        notificationId: 'soft-awareness-c:1|weird-softAwareness',
        intensity: ReminderIntensity.softAwareness,
      );

      final decoded = NotificationPayload.decode(payload.encode());

      expect(decoded!.commitmentId, 'c:1|weird');
    });

    test('the payload carries no commitment title', () {
      const payload = NotificationPayload(
        commitmentId: 'c1',
        notificationId: 'n1',
        intensity: ReminderIntensity.softAwareness,
      );

      expect(payload.encode(), isNot(contains('title')));
    });
  });

  group('refusing to invent state', () {
    test('a null payload decodes to nothing', () {
      expect(NotificationPayload.decode(null), isNull);
    });

    test('a malformed payload decodes to nothing rather than a guess', () {
      expect(NotificationPayload.decode('not json at all'), isNull);
    });

    test('a payload without a commitment id decodes to nothing', () {
      expect(NotificationPayload.decode('{"notificationId":"n1"}'), isNull);
    });

    test('an unknown intensity falls back rather than throwing', () {
      final decoded = NotificationPayload.decode(
        '{"commitmentId":"c1","notificationId":"n1","intensity":"telepathy"}',
      );

      expect(decoded, isNotNull);
      expect(decoded!.intensity, ReminderIntensity.softAwareness);
    });
  });

  group('action identifiers', () {
    test('every action the user can take maps back to itself', () {
      for (final action in NotificationActionType.values) {
        expect(
          notificationActionFromId(notificationActionId(action)),
          action,
          reason: '${action.name} must survive the platform round trip',
        );
      }
    });

    test('an unrecognised action id is not silently treated as done', () {
      expect(notificationActionFromId('com.example.somethingElse'), isNull);
    });

    test('tapping the notification body is not an action', () {
      expect(notificationActionFromId(null), isNull);
    });
  });
}
