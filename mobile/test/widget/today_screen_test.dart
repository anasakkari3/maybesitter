import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:maybesitter_mobile/features/today/today_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
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
      // The Today screen now leads with the V03 next-step card, so a default
      // 800px test viewport pushes the commitment list below the fold and its
      // lazy slivers are never built. Give this test a taller surface rather
      // than weakening what it asserts.
      tester.view.physicalSize = const Size(1200, 3600);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            todayCommitmentsProvider.overrideWithValue(testCommitments),
          ],
          child: const MaterialApp(
            supportedLocales: AppLocalizations.supportedLocales,
            localizationsDelegates: [
              AppLocalizations.delegate,
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            home: TodayScreen(),
          ),
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
