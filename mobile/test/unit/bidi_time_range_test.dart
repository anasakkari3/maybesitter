import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/core/utilities/date_formatter.dart';

const lri = DateFormatter.lri;
const pdi = DateFormatter.pdi;

/// Index of [needle] ignoring isolate marks, so assertions can talk about the
/// logical order of the tokens rather than the mark positions.
int logicalIndexOf(String haystack, String needle) =>
    DateFormatter.stripIsolates(haystack).indexOf(needle);

void main() {
  group('BiDi-safe time formatting', () {
    test('range isolates each endpoint and the range as a whole', () {
      final out = DateFormatter.formatTimeRange('09:00 AM', '11:30 AM');

      // Outer isolate wraps everything.
      expect(out.startsWith(lri), isTrue);
      expect(out.endsWith(pdi), isTrue);

      // Each endpoint is individually isolated.
      expect(out.contains('${lri}09:00 AM$pdi'), isTrue);
      expect(out.contains('${lri}11:30 AM$pdi'), isTrue);

      // Semantic order is preserved: start still precedes end.
      expect(
        logicalIndexOf(out, '09:00'),
        lessThan(logicalIndexOf(out, '11:30')),
      );

      // And the visible characters are unchanged once marks are stripped.
      expect(DateFormatter.stripIsolates(out), '09:00 AM — 11:30 AM');
    });

    test('12-hour AM/PM format keeps the marker attached to its time', () {
      final out = DateFormatter.formatTimeRange('09:00 AM', '01:30 PM');
      expect(out.contains('${lri}09:00 AM$pdi'), isTrue);
      expect(out.contains('${lri}01:30 PM$pdi'), isTrue);
      expect(DateFormatter.stripIsolates(out), '09:00 AM — 01:30 PM');
    });

    test('24-hour format is isolated the same way', () {
      final out = DateFormatter.formatTimeRange('09:00', '17:30');
      expect(out.contains('${lri}09:00$pdi'), isTrue);
      expect(out.contains('${lri}17:30$pdi'), isTrue);
      expect(
        logicalIndexOf(out, '09:00'),
        lessThan(logicalIndexOf(out, '17:30')),
      );
    });

    test('single-sided and empty ranges stay well formed', () {
      expect(DateFormatter.formatTimeRange(null, null), 'Full day');
      expect(
        DateFormatter.stripIsolates(
          DateFormatter.formatTimeRange('09:00', null),
        ),
        '09:00',
      );
      expect(
        DateFormatter.stripIsolates(
          DateFormatter.formatTimeRange(null, '17:30'),
        ),
        '17:30',
      );
      expect(DateFormatter.formatTime(null), 'Full day');
      expect(DateFormatter.formatTime('09:00'), '${lri}09:00$pdi');
    });

    /// Renders the range inside a paragraph of the given script and direction.
    /// A correct implementation renders without error and keeps the tokens in
    /// logical order in the widget tree for every locale.
    Future<void> pumpRange(
      WidgetTester tester,
      TextDirection direction,
      String surroundingText,
    ) async {
      final range = DateFormatter.formatTimeRange('09:00 AM', '11:30 AM');
      await tester.pumpWidget(
        MaterialApp(
          home: Directionality(
            textDirection: direction,
            child: Scaffold(body: Text('$surroundingText $range')),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      final rendered = tester.widget<Text>(find.byType(Text)).data!;
      expect(
        logicalIndexOf(rendered, '09:00'),
        lessThan(logicalIndexOf(rendered, '11:30')),
        reason: 'start must precede end in $direction',
      );
      expect(rendered.contains(lri), isTrue);
    }

    testWidgets('Hebrew RTL 09:00–11:30', (tester) async {
      await pumpRange(tester, TextDirection.rtl, 'שעה');
    });

    testWidgets('Arabic RTL 09:00–11:30', (tester) async {
      await pumpRange(tester, TextDirection.rtl, 'الوقت');
    });

    testWidgets('English LTR 09:00–11:30', (tester) async {
      await pumpRange(tester, TextDirection.ltr, 'Time');
    });

    testWidgets('mixed date and time text in RTL', (tester) async {
      final range = DateFormatter.formatTimeRange('09:00 AM', '11:30 AM');
      final date = DateFormatter.formatShortDate(DateTime(2026, 7, 30));
      await tester.pumpWidget(
        MaterialApp(
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: Scaffold(body: Text('יום חמישי, $date $range')),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      final rendered = tester.widget<Text>(find.byType(Text)).data!;
      expect(
        logicalIndexOf(rendered, '09:00'),
        lessThan(logicalIndexOf(rendered, '11:30')),
      );
    });
  });
}
