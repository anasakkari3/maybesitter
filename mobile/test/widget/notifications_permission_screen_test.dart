import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/settings/notifications_permission_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/mock/mock_notification_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('granting permission enables notification settings', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final service = MockNotificationService(
      initialPermissionState: NotificationPermissionState.notDetermined,
      requestedPermissionState: NotificationPermissionState.granted,
    );
    final container = ProviderContainer(
      overrides: [notificationServiceProvider.overrideWithValue(service)],
    );
    addTearDown(container.dispose);
    container.read(appSettingsProvider.notifier).toggleNotifications(false);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          supportedLocales: AppLocalizations.supportedLocales,
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: const NotificationsPermissionScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Enabled'));
    await tester.pumpAndSettle();

    expect(service.requestPermissionCallCount, 1);
    expect(container.read(appSettingsProvider).notificationsEnabled, isTrue);
  });

  testWidgets('denied permission keeps notification settings off', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final service = MockNotificationService(
      initialPermissionState: NotificationPermissionState.notDetermined,
      requestedPermissionState: NotificationPermissionState.denied,
    );
    final container = ProviderContainer(
      overrides: [notificationServiceProvider.overrideWithValue(service)],
    );
    addTearDown(container.dispose);
    container.read(appSettingsProvider.notifier).toggleNotifications(false);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          supportedLocales: AppLocalizations.supportedLocales,
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: const NotificationsPermissionScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Enabled'));
    await tester.pumpAndSettle();

    expect(service.requestPermissionCallCount, 1);
    expect(container.read(appSettingsProvider).notificationsEnabled, isFalse);
    expect(find.byType(NotificationsPermissionScreen), findsOneWidget);
  });
}
