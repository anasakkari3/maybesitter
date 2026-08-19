import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models/commitment.dart';
import '../models/pilot_loop_analytics.dart';
import '../design_system/theme/app_theme.dart';
import '../features/onboarding/onboarding_screen.dart';
import '../features/pilot/pilot_access_screen.dart';
import '../l10n/generated/app_localizations.dart';
import '../services/providers.dart';
import '../services/widget_deep_link_service.dart';
import 'router.dart';

class MaybesitterApp extends ConsumerStatefulWidget {
  const MaybesitterApp({super.key});

  @override
  ConsumerState<MaybesitterApp> createState() => _MaybesitterAppState();
}

class _MaybesitterAppState extends ConsumerState<MaybesitterApp> {
  final WidgetDeepLinkService _deepLinkService = const WidgetDeepLinkService();
  ProviderSubscription<AsyncValue<List<Commitment>>>? _presenceSubscription;
  ProviderSubscription<Object?>? _watchFlagsSubscription;
  ProviderSubscription<Object?>? _awarenessSettingsSubscription;
  ProviderSubscription<Object?>? _awarenessRoutineSubscription;
  ProviderSubscription<Object?>? _awarenessFlagsSubscription;

  @override
  void initState() {
    super.initState();
    _presenceSubscription = ref.listenManual<AsyncValue<List<Commitment>>>(
      commitmentsStreamProvider,
      (_, next) {
        final publisher = ref.read(pilotPresenceSnapshotPublisherProvider);
        _syncWatchAvailability();
        if (!ref.read(pilotPresenceFeatureFlagsProvider).widget) {
          unawaited(publisher.clearWidgetSnapshot());
          return;
        }

        final commitments = next.valueOrNull;
        if (commitments == null) return;
        unawaited(publisher.publishWidgetSnapshot(commitments));
        _syncSoftAwarenessSchedules(commitments);
      },
      fireImmediately: true,
    );
    _watchFlagsSubscription = ref.listenManual(
      pilotPresenceFeatureFlagsProvider,
      (_, __) => _syncWatchAvailability(),
      fireImmediately: true,
    );
    _awarenessSettingsSubscription = ref.listenManual(
      appSettingsProvider,
      (_, __) => _syncSoftAwarenessSchedules(),
    );
    _awarenessRoutineSubscription = ref.listenManual(
      routineProfileProvider,
      (_, __) => _syncSoftAwarenessSchedules(),
    );
    _awarenessFlagsSubscription = ref.listenManual(
      pilotPresenceFeatureFlagsProvider,
      (_, __) => _syncSoftAwarenessSchedules(),
    );
    _deepLinkService.start((location) {
      if (!mounted) return;
      _recordPilotLoopDeepLink(location);
      appRouter.go(location);
    });
  }

  @override
  void dispose() {
    _presenceSubscription?.close();
    _watchFlagsSubscription?.close();
    _awarenessSettingsSubscription?.close();
    _awarenessRoutineSubscription?.close();
    _awarenessFlagsSubscription?.close();
    _deepLinkService.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(appSettingsProvider);

    return MaterialApp.router(
      title: 'Maybesitter',
      debugShowCheckedModeBanner: false,
      themeMode: settings.themeMode.toThemeMode,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      routerConfig: appRouter,
      builder: (context, child) => PilotBootstrapGate(
        child: _OnboardingGate(
          hasLoadedSettings: settings.hasLoadedSettings,
          hasCompletedOnboarding: settings.hasCompletedOnboarding,
          child: child ?? const SizedBox.shrink(),
        ),
      ),
      locale: settings.localeOption.locale,
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
    );
  }

  void _recordPilotLoopDeepLink(String location) {
    final flags = ref.read(pilotPresenceFeatureFlagsProvider);
    final parsed = Uri.tryParse(location);
    final source = parsed?.queryParameters['source'] == 'widget'
        ? 'widget'
        : 'external';
    final targetRoute = _analyticsTargetRoute(parsed);
    if (targetRoute == null) return;
    try {
      if (source == 'widget') {
        unawaited(
          ref
              .read(pilotLoopAnalyticsServiceProvider)
              .record(
                PilotLoopAnalyticsEvent.widgetTap(
                  surface: 'homeWidget',
                  targetRoute: targetRoute,
                  flags: flags,
                ),
              )
              .catchError((_) {}),
        );
      }
      unawaited(
        ref
            .read(pilotLoopAnalyticsServiceProvider)
            .record(
              PilotLoopAnalyticsEvent.deepLinkOpened(
                source: source,
                targetRoute: targetRoute,
                flags: flags,
              ),
            )
            .catchError((_) {}),
      );
    } catch (_) {}
  }

  String? _analyticsTargetRoute(Uri? uri) {
    return switch (uri?.path) {
      '/capture' => 'capture',
      '/today' => 'today',
      String path when path.startsWith('/commitments/') => 'commitment_detail',
      _ => null,
    };
  }

  void _syncSoftAwarenessSchedules([List<Commitment>? commitments]) {
    final currentCommitments =
        commitments ?? ref.read(commitmentsStreamProvider).valueOrNull;
    if (currentCommitments == null) return;
    unawaited(
      ref
          .read(softAwarenessReminderEngineProvider)
          .syncCommitments(currentCommitments),
    );
  }

  void _syncWatchAvailability() {
    final enabled = ref.read(pilotPresenceFeatureFlagsProvider).watch;
    unawaited(
      ref
          .read(pilotPresenceWatchConfigStoreProvider)
          .setEnabled(enabled)
          .catchError((_) {}),
    );
  }
}

class _OnboardingGate extends StatelessWidget {
  final bool hasLoadedSettings;
  final bool hasCompletedOnboarding;
  final Widget child;

  const _OnboardingGate({
    required this.hasLoadedSettings,
    required this.hasCompletedOnboarding,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    if (!hasLoadedSettings) return const SizedBox.shrink();
    if (!hasCompletedOnboarding) return const OnboardingScreen();
    return child;
  }
}
