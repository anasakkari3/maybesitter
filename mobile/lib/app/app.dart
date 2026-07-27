import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../design_system/theme/app_theme.dart';
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
      locale: settings.localeOption.locale,
      supportedLocales: const [
        Locale('en', 'US'),
        Locale('ar', ''),
        Locale('he', ''),
      ],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
    );
  }
}
