import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/services/contracts/timezone_service.dart';
import 'package:maybesitter_mobile/services/timezone_service_impl.dart';

void main() {
  group('TimezoneService Closure Resolution & IANA Membership Tests', () {
    test('1. Platform resolver returns Asia/Jerusalem', () async {
      final service = DefaultTimezoneService(
        deviceTimezoneProvider: () async => 'Asia/Jerusalem',
      );
      final result = await service.resolveTimezone(userTimezone: null);
      expect(result, equals('Asia/Jerusalem'));
    });

    test('2. Platform resolver returns America/New_York', () async {
      final service = DefaultTimezoneService(
        deviceTimezoneProvider: () async => 'America/New_York',
      );
      final result = await service.resolveTimezone(userTimezone: null);
      expect(result, equals('America/New_York'));
    });

    test('3. Platform resolver returns Europe/London', () async {
      final service = DefaultTimezoneService(
        deviceTimezoneProvider: () async => 'Europe/London',
      );
      final result = await service.resolveTimezone(userTimezone: null);
      expect(result, equals('Europe/London'));
    });

    test('4. Platform resolver returns IDT (abbreviation rejected)', () async {
      final service = DefaultTimezoneService(
        deviceTimezoneProvider: () async => 'IDT',
      );
      final result = await service.resolveTimezone(userTimezone: null);
      expect(result, equals('Asia/Jerusalem'));
    });

    test(
      '5. Platform resolver returns Pacific Standard Time (display name rejected)',
      () async {
        final service = DefaultTimezoneService(
          deviceTimezoneProvider: () async => 'Pacific Standard Time',
        );
        final result = await service.resolveTimezone(userTimezone: null);
        expect(result, equals('Asia/Jerusalem'));
      },
    );

    test(
      '6. Platform resolver returns Fake/Imaginary (rejected by IANA database)',
      () async {
        final service = DefaultTimezoneService(
          deviceTimezoneProvider: () async => 'Fake/Imaginary_Place',
        );
        final result = await service.resolveTimezone(userTimezone: null);
        expect(result, equals('Asia/Jerusalem'));
      },
    );

    test('7. Platform resolver returns empty value', () async {
      final service = DefaultTimezoneService(
        deviceTimezoneProvider: () async => '',
      );
      final result = await service.resolveTimezone(userTimezone: null);
      expect(result, equals('Asia/Jerusalem'));
    });

    test('8. Platform resolver throws exception', () async {
      final service = DefaultTimezoneService(
        deviceTimezoneProvider: () async =>
            throw Exception('Platform channel failed'),
      );
      final result = await service.resolveTimezone(userTimezone: null);
      expect(result, equals('Asia/Jerusalem'));
    });

    test('9. Explicit user value exists in IANA database', () async {
      final service = DefaultTimezoneService();
      final result = await service.resolveTimezone(
        userTimezone: 'America/Chicago',
      );
      expect(result, equals('America/Chicago'));
    });

    test(
      '10. Explicit user value has valid syntax but does not exist in IANA database',
      () async {
        final service = DefaultTimezoneService(
          deviceTimezoneProvider: () async => 'Europe/Paris',
        );
        // Valid syntax (Area/Location) but non-existent city in IANA db
        final result = await service.resolveTimezone(
          userTimezone: 'NonExistent/Imaginary_City',
        );
        expect(result, equals('Europe/Paris'));
      },
    );

    test('11. Fallback is Asia/Jerusalem', () async {
      final service = DefaultTimezoneService(
        deviceTimezoneProvider: () async => null,
      );
      final result = await service.resolveTimezone(userTimezone: null);
      expect(result, equals('Asia/Jerusalem'));
    });

    test('TimezoneService.isValidIana requires database membership proof', () {
      expect(TimezoneService.isValidIana('Asia/Jerusalem'), isTrue);
      expect(TimezoneService.isValidIana('America/New_York'), isTrue);
      expect(TimezoneService.isValidIana('Europe/London'), isTrue);
      expect(TimezoneService.isValidIana('IDT'), isFalse);
      expect(TimezoneService.isValidIana('Pacific Standard Time'), isFalse);
      expect(TimezoneService.isValidIana('Fake/Imaginary_Zone'), isFalse);
    });
  });
}
