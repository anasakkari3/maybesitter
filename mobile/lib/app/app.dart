import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models/commitment.dart';
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

  @override
  void initState() {
    super.initState();
    _presenceSubscription = ref.listenManual<AsyncValue<List<Commitment>>>(
      commitmentsStreamProvider,
      (_, next) {
        final publisher = ref.read(pilotPresenceSnapshotPublisherProvider);
        if (!ref.read(pilotPresenceFeatureFlagsProvider).widget) {
          unawaited(publisher.clearWidgetSnapshot());
          return;
        }

        final commitments = next.valueOrNull;
        if (commitments == null) return;
        unawaited(publisher.publishWidgetSnapshot(commitments));
      },
      fireImmediately: true,
    );
    _deepLinkService.start((location) {
      if (!mounted) return;
      appRouter.go(location);
    });
  }

  @override
  void dispose() {
    _presenceSubscription?.close();
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
