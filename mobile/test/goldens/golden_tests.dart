import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:maybesitter_mobile/design_system/theme/app_theme.dart';
import 'package:maybesitter_mobile/features/capture/capture_composer_screen.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/features/capture/extraction_review_screen.dart';
import 'package:maybesitter_mobile/features/capture/success_save_screen.dart';
import 'package:maybesitter_mobile/features/settings/settings_screen.dart';
import 'package:maybesitter_mobile/features/today/today_screen.dart';
import 'package:maybesitter_mobile/features/upcoming/upcoming_screen.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/providers.dart';

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = true;
  });

  final testCommitments = [
    Commitment(
      id: 't-1',
      title: 'Pet-Sitter Briefing',
      description: 'Review feeding schedule with Marcus.',
      scheduledDate: DateTime(2026, 7, 28),
      startTime: '10:30 AM',
      priority: CommitmentPriority.must,
      status: CommitmentStatus.pending,
    ),
  ];

  Widget buildTestableWidget({
    required Widget child,
    ThemeMode themeMode = ThemeMode.light,
    Size size = const Size(390, 844),
    List<Override> overrides = const [],
  }) {
    return ProviderScope(
      overrides: [
        todayCommitmentsProvider.overrideWithValue(testCommitments),
        upcomingCommitmentsProvider.overrideWithValue(testCommitments),
        ...overrides,
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.lightTheme,
        darkTheme: AppTheme.darkTheme,
        themeMode: themeMode,
        home: MediaQuery(
          data: MediaQueryData(size: size, devicePixelRatio: 1.0),
          child: SizedBox(
            width: size.width,
            height: size.height,
            child: Material(type: MaterialType.transparency, child: child),
          ),
        ),
      ),
    );
  }

  group('Golden Visual Regression Tests', () {
    testWidgets('Today Light Golden', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(
        buildTestableWidget(
          child: const TodayScreen(),
          themeMode: ThemeMode.light,
        ),
      );
      await tester.pumpAndSettle();

      await expectLater(
        find.byType(TodayScreen),
        matchesGoldenFile('goldens/today_light.png'),
      );
    });

    testWidgets('Today Dark Golden', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(
        buildTestableWidget(
          child: const TodayScreen(),
          themeMode: ThemeMode.dark,
        ),
      );
      await tester.pumpAndSettle();

      await expectLater(
        find.byType(TodayScreen),
        matchesGoldenFile('goldens/today_dark.png'),
      );
    });

    testWidgets('Capture Composer Golden', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(
        buildTestableWidget(child: const CaptureComposerScreen()),
      );
      await tester.pumpAndSettle();

      await expectLater(
        find.byType(CaptureComposerScreen),
        matchesGoldenFile('goldens/capture_composer.png'),
      );
    });

    testWidgets('Extraction Review Golden', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final container = ProviderContainer(
        overrides: [
          todayCommitmentsProvider.overrideWithValue(testCommitments),
        ],
      );
      container
          .read(captureControllerProvider.notifier)
          .previewState(CaptureStatus.needsConfirmation);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.lightTheme,
            home: const ExtractionReviewScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await expectLater(
        find.byType(ExtractionReviewScreen),
        matchesGoldenFile('goldens/extraction_review.png'),
      );
    });

    testWidgets('Successful Save Golden', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final container = ProviderContainer(
        overrides: [
          todayCommitmentsProvider.overrideWithValue(testCommitments),
        ],
      );
      container
          .read(captureControllerProvider.notifier)
          .previewState(CaptureStatus.saved);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.lightTheme,
            home: const SuccessSaveScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await expectLater(
        find.byType(SuccessSaveScreen),
        matchesGoldenFile('goldens/successful_save.png'),
      );
    });

    testWidgets('Upcoming Agenda Golden', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(
        buildTestableWidget(child: const UpcomingScreen()),
      );
      await tester.pumpAndSettle();

      await expectLater(
        find.byType(UpcomingScreen),
        matchesGoldenFile('goldens/upcoming.png'),
      );
    });

    testWidgets('Settings Golden', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(
        buildTestableWidget(child: const SettingsScreen()),
      );
      await tester.pumpAndSettle();

      await expectLater(
        find.byType(SettingsScreen),
        matchesGoldenFile('goldens/settings.png'),
      );
    });

    testWidgets('Android Viewport Golden (360x800)', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(
        buildTestableWidget(
          child: const TodayScreen(),
          size: const Size(360, 800),
        ),
      );
      await tester.pumpAndSettle();

      await expectLater(
        find.byType(TodayScreen),
        matchesGoldenFile('goldens/android_viewport.png'),
      );
    });

    testWidgets('iPhone Viewport Golden (390x844)', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(
        buildTestableWidget(
          child: const TodayScreen(),
          size: const Size(390, 844),
        ),
      );
      await tester.pumpAndSettle();

      await expectLater(
        find.byType(TodayScreen),
        matchesGoldenFile('goldens/iphone_viewport.png'),
      );
    });
  });
}
