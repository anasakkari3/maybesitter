import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:maybesitter_mobile/features/today/today_screen.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/providers.dart';

void main() {
  final testCommitments = [
    Commitment(
      id: 't-1',
      title: 'Pet-Sitter Briefing',
      description: 'Review feeding schedule with Marcus.',
      scheduledDate: DateTime.now(),
      startTime: '10:30 AM',
      priority: CommitmentPriority.must,
      status: CommitmentStatus.pending,
    ),
  ];

  group('TodayScreen Widget Tests', () {
    testWidgets('Renders TodayScreen with commitments', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            todayCommitmentsProvider.overrideWithValue(testCommitments),
          ],
          child: const MaterialApp(home: TodayScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Maybesitter'), findsOneWidget);
      expect(find.text('Good morning, Alex'), findsOneWidget);
      expect(find.text('Pet-Sitter Briefing'), findsOneWidget);
    });

    testWidgets('MaybesitterApp renders full app with router', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(const ProviderScope(child: MaybesitterApp()));
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.text('Maybesitter'), findsOneWidget);
    });
  });
}
