import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/today/today_screen.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/providers.dart';

void main() {
  final testCommitments = [
    Commitment(
      id: 't-1',
      title: 'Pet-Sitter Briefing',
      scheduledDate: DateTime.now(),
      startTime: '10:30 AM',
      priority: CommitmentPriority.must,
      status: CommitmentStatus.pending,
    ),
  ];

  group('RTL & Accessibility Tests', () {
    testWidgets('Renders TodayScreen in RTL Directionality', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            todayCommitmentsProvider.overrideWithValue(testCommitments),
          ],
          child: const MaterialApp(
            home: Directionality(
              textDirection: TextDirection.rtl,
              child: TodayScreen(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Maybesitter'), findsOneWidget);
      expect(find.text('Good morning, Alex'), findsOneWidget);
    });

    testWidgets('Renders TodayScreen under Large Text Scale (2.0)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            todayCommitmentsProvider.overrideWithValue(testCommitments),
          ],
          child: MaterialApp(
            builder: (context, child) {
              return MediaQuery(
                data: MediaQuery.of(
                  context,
                ).copyWith(textScaler: const TextScaler.linear(2.0)),
                child: child!,
              );
            },
            home: const TodayScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Maybesitter'), findsOneWidget);
    });
  });
}
