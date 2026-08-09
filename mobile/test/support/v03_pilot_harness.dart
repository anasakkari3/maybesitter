import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/next_step.dart';
import 'package:maybesitter_mobile/services/contracts/next_step_service.dart';
import 'package:maybesitter_mobile/services/contracts/pilot_trust_service.dart';
import 'package:maybesitter_mobile/services/mock/mock_next_step_service.dart';
import 'package:maybesitter_mobile/services/mock/mock_pilot_trust_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';

/// Shared scaffolding for the V03 pilot widget tests.
///
/// The trust double and the recommendation double share one instance, exactly
/// as the app wires them, so a test that flips quiet mode sees the
/// recommendation surface block for the same reason the real server would.
class V03Harness {
  final MockPilotTrustService trust;
  final MockNextStepService nextStep;

  V03Harness._(this.trust, this.nextStep);

  factory V03Harness({
    bool recommendationConsent = true,
    bool analyticsConsent = false,
    bool calendarConsent = false,
    bool quietMode = false,
    DateTime? firstValueAt,
    DateTime? revokedAt,
    DateTime? deletedAt,
    int confirmedCommitmentCount = 3,
    bool featureEnabled = true,
    bool killSwitchActive = false,
    bool allowlisted = true,
    bool suspended = false,
    NextStepRecommendation? proposal = MockNextStepService.defaultProposal,
    NextStepState emptyState = NextStepState.empty,
    Object? failWith,
  }) {
    final trust = MockPilotTrustService(
      recommendationConsent: recommendationConsent,
      analyticsConsent: analyticsConsent,
      calendarConsent: calendarConsent,
      quietMode: quietMode,
      firstValueAt: firstValueAt,
      revokedAt: revokedAt,
      deletedAt: deletedAt,
      confirmedCommitmentCount: confirmedCommitmentCount,
      featureEnabled: featureEnabled,
      killSwitchActive: killSwitchActive,
      allowlisted: allowlisted,
      suspended: suspended,
    );
    return V03Harness._(
      trust,
      MockNextStepService(
        trustService: trust,
        proposal: proposal,
        emptyState: emptyState,
        failWith: failWith,
      ),
    );
  }

  List<Override> get overrides => [
    appConfigProvider.overrideWith(
      (ref) => const AppConfig(),
    ),
    pilotTrustServiceProvider.overrideWithValue(trust as PilotTrustService),
    nextStepServiceProvider.overrideWithValue(nextStep as NextStepService),
  ];

  /// Pumps [child] inside the provider scope and a localized MaterialApp.
  ///
  /// The surface is deliberately tall: these screens are dense, and a default
  /// 800px viewport would hide controls behind lazy layout and turn genuine
  /// assertions into false negatives.
  /// Pass a bare widget (such as [NextStepCard]) and it is hosted in a
  /// scrollable Scaffold. Pass a full screen, which brings its own Scaffold,
  /// and set [isFullScreen] so it is not nested inside an unbounded viewport.
  Future<void> pump(
    WidgetTester tester,
    Widget child, {
    Locale locale = const Locale('en'),
    Size surface = const Size(420, 1400),
    bool isFullScreen = false,
  }) async {
    tester.view.physicalSize = Size(surface.width * 3, surface.height * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      ProviderScope(
        overrides: overrides,
        child: MaterialApp(
          locale: locale,
          supportedLocales: AppLocalizations.supportedLocales,
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: isFullScreen
              ? child
              : Scaffold(body: SingleChildScrollView(child: child)),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }
}

/// Localized strings for a locale, without needing a BuildContext.
AppLocalizations l10nFor(String languageCode) =>
    lookupAppLocalizations(Locale(languageCode));
