import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/pilot/pilot_access_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/pilot_trust.dart';
import 'package:maybesitter_mobile/services/auth/pilot_credential_store.dart';
import 'package:maybesitter_mobile/services/contracts/pilot_trust_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Holds no token, so the gate resolves to `noCredential` without any network.
class _EmptyCredentialStore implements PilotCredentialStore {
  @override
  Future<String?> readToken() async => null;
  @override
  Future<void> writeToken(String token) async {}
  @override
  Future<void> deleteToken() async {}
}

/// Never reached in these tests (no token => no validation call). Present only
/// so the provider graph does not construct a real HTTP-backed trust service.
class _UnusedTrustService implements PilotTrustService {
  @override
  Future<PilotTrustSnapshot> getSnapshot() async =>
      throw UnimplementedError('no token stored, so this must not be called');
  @override
  Future<PilotTrustSnapshot> apply({required PilotTrustAction action}) async =>
      throw UnimplementedError();
}

/// Regression cover for the composition defect that made a default build
/// unusable: `PilotBootstrapGate` wraps the ENTIRE app, and it used to
/// short-circuit on `config.isMock`. When the default `apiMode` flipped from
/// mock to localBackend (so real capture extraction became the default), that
/// short-circuit stopped firing, the gate found no stored pilot token, and
/// every default build rendered the pilot token screen instead of the app.
///
/// The gate now keys on its own `requirePilotAccessGate` flag, which is
/// independent of `apiMode`.
Widget _wrap(Widget home) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: const [
      AppLocalizations.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: home,
  );
}

void main() {
  group('PilotBootstrapGate', () {
    const appBody = Text('APP-BODY', key: Key('app-body'));

    testWidgets(
      'a default build (no dart-defines) renders the app, not the token screen',
      (tester) async {
        SharedPreferences.setMockInitialValues({});

        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              // The exact config a build with no dart-defines produces.
              appConfigProvider.overrideWith(
                (ref) => const AppConfig.fromEnvironment(),
              ),
            ],
            child: _wrap(const PilotBootstrapGate(child: appBody)),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('app-body')),
          findsOneWidget,
          reason: 'A default build must reach the app.',
        );
        expect(
          find.byType(PilotAccessScreen),
          findsNothing,
          reason: 'A default build must not be held behind the pilot gate.',
        );
      },
    );

    testWidgets(
      'real-backend mode alone does not activate the gate',
      (tester) async {
        SharedPreferences.setMockInitialValues({});

        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              appConfigProvider.overrideWith(
                (ref) => const AppConfig(apiMode: ApiMode.localBackend),
              ),
            ],
            child: _wrap(const PilotBootstrapGate(child: appBody)),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(const Key('app-body')), findsOneWidget);
        expect(find.byType(PilotAccessScreen), findsNothing);
      },
    );

    testWidgets(
      'the gate still protects pilot builds that ask for it',
      (tester) async {
        SharedPreferences.setMockInitialValues({});

        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              appConfigProvider.overrideWith(
                (ref) => const AppConfig(
                  apiMode: ApiMode.localBackend,
                  requirePilotAccessGate: true,
                ),
              ),
              pilotCredentialStoreProvider.overrideWithValue(
                _EmptyCredentialStore(),
              ),
              pilotTrustServiceProvider.overrideWithValue(
                _UnusedTrustService(),
              ),
            ],
            child: _wrap(const PilotBootstrapGate(child: appBody)),
          ),
        );
        await tester.pumpAndSettle();

        // No stored credential -> the gate must hold the app back.
        expect(
          find.byType(PilotAccessScreen),
          findsOneWidget,
          reason: 'Pilot access control must still work when requested.',
        );
        expect(find.byKey(const Key('app-body')), findsNothing);
      },
    );
  });
}
