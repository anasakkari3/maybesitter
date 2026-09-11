import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/capture/capture_composer_screen.dart';
import 'package:maybesitter_mobile/features/settings/pilot_feedback_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/pilot_loop_analytics.dart';
import 'package:maybesitter_mobile/services/clipboard_import_service.dart';
import 'package:maybesitter_mobile/services/contracts/pilot_loop_analytics_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeClipboardImportService implements ClipboardImportService {
  final String? text;

  const _FakeClipboardImportService(this.text);

  @override
  Future<String?> readPlainText() async => text;
}

class _FakePilotLoopAnalyticsService implements PilotLoopAnalyticsService {
  final List<PilotLoopAnalyticsEvent> events = [];

  @override
  Future<void> record(PilotLoopAnalyticsEvent event) async {
    event.toJson();
    events.add(event);
  }
}

Widget _wrap(Widget child, {List<Override> overrides = const []}) {
  return ProviderScope(
    overrides: overrides,
    child: MaterialApp(
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: child,
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('clipboard import requires review before populating composer', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        const CaptureComposerScreen(),
        overrides: [
          appConfigProvider.overrideWith(
            (ref) => const AppConfig(enablePilotImports: true),
          ),
          clipboardImportServiceProvider.overrideWithValue(
            const _FakeClipboardImportService(
              'Forward the school email and book the call',
            ),
          ),
        ],
      ),
    );

    await tester.tap(find.byIcon(Icons.content_paste_go_rounded));
    await tester.pumpAndSettle();

    expect(find.text('Review imported text'), findsOneWidget);
    expect(find.text('Use this text'), findsOneWidget);

    await tester.tap(find.text('Use this text'));
    await tester.pumpAndSettle();

    expect(
      find.text('Forward the school email and book the call'),
      findsOneWidget,
    );
  });

  testWidgets('pilot feedback screen records a structured event', (
    tester,
  ) async {
    final analytics = _FakePilotLoopAnalyticsService();

    await tester.pumpWidget(
      _wrap(
        const PilotFeedbackScreen(),
        overrides: [
          appConfigProvider.overrideWith(
            (ref) => const AppConfig(enablePilotImports: true),
          ),
          pilotLoopAnalyticsServiceProvider.overrideWithValue(analytics),
        ],
      ),
    );

    await tester.ensureVisible(find.text('Send feedback'));
    await tester.tap(find.text('Send feedback'));
    await tester.pumpAndSettle();

    expect(analytics.events, hasLength(1));
    expect(
      analytics.events.single.name,
      PilotLoopAnalyticsEventName.pilotFeedbackSubmitted,
    );
    expect(analytics.events.single.properties['feedbackSurface'], 'widget');
  });
}
