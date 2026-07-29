import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/services/contracts/timezone_service.dart';
import 'package:maybesitter_mobile/services/timezone_service_impl.dart';

void main() {
  group('TimezoneService Resolution & Validation Tests', () {
    test('Explicit Asia/Jerusalem resolved successfully', () async {
      final service = DefaultTimezoneService();
      final result = await service.resolveTimezone(
        userTimezone: 'Asia/Jerusalem',
      );
      expect(result, equals('Asia/Jerusalem'));
    });

    test('Explicit Europe/London resolved successfully', () async {
      final service = DefaultTimezoneService();
      final result = await service.resolveTimezone(
        userTimezone: 'Europe/London',
      );
      expect(result, equals('Europe/London'));
    });

    test(
      'Explicit invalid value falls through to device or fallback',
      () async {
        final service = DefaultTimezoneService(
          deviceTimezoneProvider: () async => 'America/Chicago',
        );
        final result = await service.resolveTimezone(
          userTimezone: 'INVALID_ZONE_123',
        );
        expect(result, equals('America/Chicago'));
      },
    );

    test(
      'Device valid IANA value resolved when user timezone is absent',
      () async {
        final service = DefaultTimezoneService(
          deviceTimezoneProvider: () async => 'America/New_York',
        );
        final result = await service.resolveTimezone(userTimezone: null);
        expect(result, equals('America/New_York'));
      },
    );

    test(
      'Device returns IDT (abbreviation rejected) -> fallback to Asia/Jerusalem',
      () async {
        final service = DefaultTimezoneService(
          deviceTimezoneProvider: () async => 'IDT',
        );
        final result = await service.resolveTimezone(userTimezone: null);
        expect(result, equals('Asia/Jerusalem'));
      },
    );

    test(
      'Device returns EET (abbreviation rejected) -> fallback to Asia/Jerusalem',
      () async {
        final service = DefaultTimezoneService(
          deviceTimezoneProvider: () async => 'EET',
        );
        final result = await service.resolveTimezone(userTimezone: null);
        expect(result, equals('Asia/Jerusalem'));
      },
    );

    test('Device returns empty string -> fallback to Asia/Jerusalem', () async {
      final service = DefaultTimezoneService(
        deviceTimezoneProvider: () async => '',
      );
      final result = await service.resolveTimezone(userTimezone: null);
      expect(result, equals('Asia/Jerusalem'));
    });

    test(
      'Device resolver throws exception -> fallback to Asia/Jerusalem',
      () async {
        final service = DefaultTimezoneService(
          deviceTimezoneProvider: () async =>
              throw Exception('Platform channel failed'),
        );
        final result = await service.resolveTimezone(userTimezone: null);
        expect(result, equals('Asia/Jerusalem'));
      },
    );

    test('Validation rejects Windows-style and abbreviation strings', () {
      expect(TimezoneService.isValidIana('Pacific Standard Time'), isFalse);
      expect(TimezoneService.isValidIana('IDT'), isFalse);
      expect(TimezoneService.isValidIana('EET'), isFalse);
      expect(TimezoneService.isValidIana('+03:00'), isFalse);
      expect(TimezoneService.isValidIana('Asia/Jerusalem'), isTrue);
      expect(
        TimezoneService.isValidIana('America/Indiana/Indianapolis'),
        isTrue,
      );
    });

    test('AppConfig.resolveTimezone enforces IANA validity', () {
      expect(
        AppConfig.resolveTimezone(
          userTimezone: 'IDT',
          deviceTimezone: 'Europe/Paris',
        ),
        equals('Europe/Paris'),
      );
      expect(
        AppConfig.resolveTimezone(userTimezone: 'IDT', deviceTimezone: 'EET'),
        equals('Asia/Jerusalem'),
      );
    });
  });
}
