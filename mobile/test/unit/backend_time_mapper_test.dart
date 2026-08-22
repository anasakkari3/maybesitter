import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/services/api/mappers/backend_time_mapper.dart';

void main() {
  group('BackendTimeMapper.instantFrom', () {
    // DateTime.toIso8601String() on a local value emits no offset, which left
    // the server to resolve it against its own zone. Everything the client
    // sends must name its instant explicitly.

    test('combines a local date and wall clock into an explicit UTC instant', () {
      final instant = BackendTimeMapper.instantFrom(DateTime(2026, 8, 23), '3:45 PM');

      expect(instant, isNotNull);
      expect(instant, endsWith('Z'));
      final parsed = DateTime.parse(instant!);
      expect(parsed.isUtc, isTrue);
      final local = parsed.toLocal();
      expect(local.year, 2026);
      expect(local.month, 8);
      expect(local.day, 23);
      expect(local.hour, 15);
      expect(local.minute, 45);
    });

    test('a late-evening time keeps its own local date', () {
      final instant = BackendTimeMapper.instantFrom(DateTime(2026, 8, 23), '11:30 PM');
      final local = DateTime.parse(instant!).toLocal();
      expect(local.day, 23);
      expect(local.hour, 23);
    });

    test('an after-midnight time keeps its own local date', () {
      final instant = BackendTimeMapper.instantFrom(DateTime(2026, 8, 23), '12:30 AM');
      final local = DateTime.parse(instant!).toLocal();
      expect(local.day, 23);
      expect(local.hour, 0);
      expect(local.minute, 30);
    });

    test('a zero-padded clock string parses the same as an unpadded one', () {
      // Seed data mixes '2:15 PM' and '09:00 AM'.
      final padded = BackendTimeMapper.instantFrom(DateTime(2026, 8, 23), '09:00 AM');
      final unpadded = BackendTimeMapper.instantFrom(DateTime(2026, 8, 23), '9:00 AM');
      expect(padded, unpadded);
    });

    test('no clock time falls back to the date itself, still explicit', () {
      final instant = BackendTimeMapper.instantFrom(DateTime(2026, 8, 23), null);
      expect(instant, isNotNull);
      expect(instant, endsWith('Z'));
      expect(DateTime.parse(instant!).toLocal().day, 23);
    });

    test('no date at all yields null rather than inventing one', () {
      expect(BackendTimeMapper.instantFrom(null, '3:45 PM'), isNull);
    });

    test('an unparseable clock string costs the time, not the whole edit', () {
      final instant = BackendTimeMapper.instantFrom(DateTime(2026, 8, 23), 'not a time');
      expect(instant, isNotNull);
      expect(instant, endsWith('Z'));
      expect(DateTime.parse(instant!).toLocal().day, 23);
    });
  });
}
