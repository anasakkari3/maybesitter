import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/services/contracts/timezone_service.dart';
import 'package:maybesitter_mobile/services/timezone_service_impl.dart';

void main() {
  group('TimezoneService Non-Restrictive IANA Database Validation Tests', () {
    test('1. Hyphenated IANA zone America/Port-au-Prince is accepted', () {
      expect(TimezoneService.isValidIana('America/Port-au-Prince'), isTrue);
    });

    test('2. Plus sign IANA zone Etc/GMT+5 is accepted', () {
      expect(TimezoneService.isValidIana('Etc/GMT+5'), isTrue);
    });

    test('3. Minus sign IANA zone Etc/GMT-0 is accepted', () {
      expect(TimezoneService.isValidIana('Etc/GMT-0'), isTrue);
    });

    test('4. Standard IANA zone Asia/Jerusalem is accepted', () {
      expect(TimezoneService.isValidIana('Asia/Jerusalem'), isTrue);
    });

    test('5. Non-existent zone Fake/Imaginary is rejected', () {
      expect(TimezoneService.isValidIana('Fake/Imaginary'), isFalse);
    });

    test('6. Abbreviation IDT is rejected', () {
      expect(TimezoneService.isValidIana('IDT'), isFalse);
    });

    test('7. UTC, Etc/UTC, and GMT standard identifiers are accepted', () {
      expect(TimezoneService.isValidIana('UTC'), isTrue);
      expect(TimezoneService.isValidIana('Etc/UTC'), isTrue);
      expect(TimezoneService.isValidIana('GMT'), isTrue);
    });

    test(
      '8. Resolver accepts hyphenated and GMT offset IANA zones from platform',
      () async {
        final service = DefaultTimezoneService(
          deviceTimezoneProvider: () async => 'America/Port-au-Prince',
        );
        final result = await service.resolveTimezone(userTimezone: null);
        expect(result, equals('America/Port-au-Prince'));
      },
    );
  });
}
