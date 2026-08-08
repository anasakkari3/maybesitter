import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/core/utilities/date_formatter.dart';

void main() {
  group('DateFormatter Tests', () {
    test('isToday returns true for DateTime.now()', () {
      expect(DateFormatter.isToday(DateTime.now()), isTrue);
    });

    test('isTomorrow returns true for DateTime.now() + 1 day', () {
      final tomorrow = DateTime.now().add(const Duration(days: 1));
      expect(DateFormatter.isTomorrow(tomorrow), isTrue);
    });

    test('formatTimeRange handles nulls gracefully', () {
      // Ranges carry bidi isolate marks so RTL cannot reorder them; assert
      // on the visible content.
      expect(
        DateFormatter.stripIsolates(
          DateFormatter.formatTimeRange('09:00 AM', '11:00 AM'),
        ),
        '09:00 AM — 11:00 AM',
      );
      expect(DateFormatter.formatTimeRange(null, null), 'Full day');
    });
  });
}
