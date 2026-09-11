import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/settings/settings_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A [NotificationService] whose reported permission can be changed after
/// construction, the way OS state changes underneath a running app when the
/// user revokes notifications from system Settings.
class _MutablePermissionNotificationService implements NotificationService {
  NotificationPermissionState state;

  _MutablePermissionNotificationService(this.state);

  @override
  Future<NotificationPermissionState> permissionState() async => state;

  @override
  Future<NotificationPermissionState> requestPermission() async => state;

  @override
  Future<void> schedule(ScheduledNotificationRequest request) async {}

  @override
  Future<void> cancelFor(String commitmentId) async {}
}

Widget _wrap(ProviderContainer container) {
  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: const SettingsScreen(),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'settings screen shows the live OS permission, not the stale cached value',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final service = _MutablePermissionNotificationService(
        NotificationPermissionState.granted,
      );
      final container = ProviderContainer(
        overrides: [notificationServiceProvider.overrideWithValue(service)],
      );
      addTearDown(container.dispose);
      // Cached state from a prior successful permission request, exactly as
      // AppSettingsNotifier.toggleNotifications leaves it.
      container.read(appSettingsProvider.notifier).toggleNotifications(true);

      await tester.pumpWidget(_wrap(container));
      await tester.pumpAndSettle();

      expect(find.text('Enabled'), findsOneWidget);

      // The user backgrounds the app, revokes notifications from system
      // Settings, then returns -- the OS gateway now reports denied, and the
      // app receives the resumed lifecycle event on the same running screen.
      service.state = NotificationPermissionState.denied;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();

      expect(find.text('Disabled'), findsOneWidget);
      expect(container.read(appSettingsProvider).notificationsEnabled, isFalse);
    },
  );
}
