import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../design_system/theme/app_theme.dart';
import '../features/pilot/pilot_access_screen.dart';
import '../l10n/generated/app_localizations.dart';
import '../services/providers.dart';
import 'router.dart';

class MaybesitterApp extends ConsumerWidget {
  const MaybesitterApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(appSettingsProvider);

    return MaterialApp.router(
      title: 'Maybesitter',
      debugShowCheckedModeBanner: false,
      themeMode: settings.themeMode.toThemeMode,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      routerConfig: appRouter,
      builder: (context, child) =>
          PilotBootstrapGate(child: child ?? const SizedBox.shrink()),
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
