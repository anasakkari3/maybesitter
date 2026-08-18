import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:maybesitter_mobile/design_system/components/maybesitter_switch.dart';
import 'package:maybesitter_mobile/features/settings/feedback_history_controller.dart';
import 'package:maybesitter_mobile/features/settings/feedback_history_screen.dart';
import 'package:maybesitter_mobile/features/settings/privacy_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/feedback_history.dart';
import 'package:maybesitter_mobile/services/contracts/feedback_history_service.dart';
import 'package:maybesitter_mobile/services/mock/mock_feedback_history_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';

/// Widget coverage for "What we noticed" and for the privacy screen it hangs
/// off. These assertions are about honesty as much as layout: that the copy
/// describes observations rather than the person, that a revoke reaches the
/// record instead of only the pixels, and that a build with nothing connected
/// says so instead of showing an empty list.
void main() {
  AppLocalizations l10nFor(String code) => lookupAppLocalizations(Locale(code));

  const titles = {
    'c-today-2': 'Weekly Meal Prep',
    'c-up-1': 'Pediatric Checkup (Leo)',
  };

  Future<void> pump(
    WidgetTester tester,
    Widget screen, {
    MockFeedbackHistoryService? service,
    Map<String, String> subjectTitles = titles,
    Locale locale = const Locale('en'),
  }) async {
    tester.view.physicalSize = const Size(420 * 3, 1600 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          feedbackHistoryServiceProvider.overrideWithValue(
            service ?? MockFeedbackHistoryService(),
          ),
          feedbackSubjectTitlesProvider.overrideWithValue(subjectTitles),
        ],
        child: MaterialApp(
          locale: locale,
          supportedLocales: AppLocalizations.supportedLocales,
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: screen,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  FeedbackHistoryRow row({
    String id = 'evt-1',
    FeedbackOutcome outcome = FeedbackOutcome.defer,
    String subjectId = 'c-today-2',
    DateTime? revokedAt,
  }) {
    return FeedbackHistoryRow(
      id: id,
      outcome: outcome,
      subjectId: subjectId,
      occurredAt: DateTime.now().subtract(const Duration(hours: 5)),
      revokedAt: revokedAt,
      canRevoke: revokedAt == null,
    );
  }

  group('feedback history — what it says', () {
    testWidgets('states what was observed, and says so in the intro', (
      tester,
    ) async {
      final l10n = l10nFor('en');
      await pump(
        tester,
        const FeedbackHistoryScreen(),
        service: MockFeedbackHistoryService(rows: [row()], baseline: null),
      );

      expect(find.text(l10n.feedbackObservedDefer), findsOneWidget);
      // The screen states outright that none of this is stored as a preference.
      expect(find.text(l10n.feedbackHistoryIntro), findsOneWidget);
    });

    testWidgets('no observation line makes a claim about the person', (
      tester,
    ) async {
      // A row describes one moment. Wording that generalises to a trait is the
      // failure this screen exists to prevent, so it is asserted against in
      // every locale rather than left to review.
      const forbidden = [
        'prefer',
        'always',
        'usually',
        'tend to',
        'you are someone',
        'يفضّل',
        'تفضّل',
        'دائمًا',
        'عادةً',
        'מעדיף',
        'מעדיפה',
        'תמיד',
        'בדרך כלל',
      ];

      for (final code in ['en', 'ar', 'he']) {
        final l10n = l10nFor(code);
        // The observation lines themselves. The intro is excluded on purpose:
        // it has to name "preference" in order to deny that anything here is
        // one, and denying the claim is the opposite of making it.
        final lines = [
          l10n.feedbackObservedAccept,
          l10n.feedbackObservedEdit,
          l10n.feedbackObservedReject,
          l10n.feedbackObservedDefer,
          l10n.feedbackObservedComplete,
          l10n.feedbackObservedIgnore,
          l10n.feedbackObservedUndo,
          l10n.feedbackObservedUnknown,
        ];
        for (final line in lines) {
          for (final word in forbidden) {
            expect(
              line.toLowerCase().contains(word),
              isFalse,
              reason: '[$code] "$line" reads as a claim about the person: "$word"',
            );
          }
        }
      }

      // And the intro does draw the distinction rather than leaving it implied.
      expect(
        l10nFor('en').feedbackHistoryIntro.toLowerCase(),
        contains('preference'),
      );
    });

    testWidgets('names the item when it is known and admits when it is not', (
      tester,
    ) async {
      final l10n = l10nFor('en');
      await pump(
        tester,
        const FeedbackHistoryScreen(),
        service: MockFeedbackHistoryService(
          rows: [
            row(id: 'evt-known', subjectId: 'c-today-2'),
            row(id: 'evt-gone', subjectId: 'c-deleted-1'),
          ],
          baseline: null,
        ),
      );

      expect(
        find.text(l10n.feedbackHistoryAboutItem('Weekly Meal Prep')),
        findsOneWidget,
      );
      // The event log holds an id, not a name. Where the item is gone the row
      // says so rather than printing the raw id at the user.
      expect(find.text(l10n.feedbackHistorySubjectUnknown), findsOneWidget);
      expect(find.textContaining('c-deleted-1'), findsNothing);
    });

    testWidgets('baseline counters are shown as counts, never as moments', (
      tester,
    ) async {
      final l10n = l10nFor('en');
      await pump(
        tester,
        const FeedbackHistoryScreen(),
        service: MockFeedbackHistoryService(
          rows: [],
          baseline: const FeedbackBaselineNotice(completedActions: 11),
        ),
      );

      expect(find.text(l10n.feedbackBaselineTitle), findsOneWidget);
      expect(find.text(l10n.feedbackBaselineMessage), findsOneWidget);
      expect(find.text(l10n.feedbackBaselineCompletedActions), findsOneWidget);
      // A counter carries no timestamp, so it never gets a revoke control.
      expect(find.text(l10n.feedbackRevokeAction), findsNothing);
    });
  });

  group('feedback history — revoking', () {
    testWidgets('revoke is one tap: no dialog, no confirmation step', (
      tester,
    ) async {
      final l10n = l10nFor('en');
      final service = MockFeedbackHistoryService(
        rows: [row(id: 'evt-1')],
        baseline: null,
      );
      await pump(tester, const FeedbackHistoryScreen(), service: service);

      await tester.tap(find.text(l10n.feedbackRevokeAction));
      await tester.pumpAndSettle();

      // Nothing interrupted the user between the tap and the correction.
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text(l10n.feedbackRevokeDoneMessage), findsOneWidget);
    });

    testWidgets('the revocation reaches the record, not just the screen', (
      tester,
    ) async {
      final l10n = l10nFor('en');
      final service = MockFeedbackHistoryService(
        rows: [row(id: 'evt-1')],
        baseline: null,
      );
      await pump(tester, const FeedbackHistoryScreen(), service: service);

      await tester.tap(find.text(l10n.feedbackRevokeAction));
      await tester.pumpAndSettle();

      // Read back through the service: the screen could show anything, but the
      // record is what future aggregates will be built from.
      final stored = (await service.getHistory()).rows.single;
      expect(stored.isRevoked, isTrue);
      expect(stored.canRevoke, isFalse);
    });

    testWidgets('a revoked row stays listed and loses only its control', (
      tester,
    ) async {
      final l10n = l10nFor('en');
      await pump(
        tester,
        const FeedbackHistoryScreen(),
        service: MockFeedbackHistoryService(
          rows: [row(id: 'evt-1', revokedAt: DateTime.now())],
          baseline: null,
        ),
      );

      // History must show corrections rather than hide them.
      expect(find.text(l10n.feedbackObservedDefer), findsOneWidget);
      expect(find.text(l10n.feedbackRevokedBadge), findsOneWidget);
      expect(find.text(l10n.feedbackRevokeAction), findsNothing);
    });

    testWidgets('a failed revoke says nothing changed and leaves the row alone', (
      tester,
    ) async {
      final l10n = l10nFor('en');
      final service = _FailingRevokeService(rows: [row(id: 'evt-1')]);
      await pump(tester, const FeedbackHistoryScreen(), service: service);

      await tester.tap(find.text(l10n.feedbackRevokeAction));
      await tester.pumpAndSettle();

      expect(find.text(l10n.feedbackRevokeFailedMessage), findsOneWidget);
      expect(find.text(l10n.feedbackRevokeDoneMessage), findsNothing);
      // Still revocable, because nothing was revoked.
      expect(find.text(l10n.feedbackRevokeAction), findsOneWidget);
    });

    testWidgets('the revoke control carries a label naming its own row', (
      tester,
    ) async {
      final l10n = l10nFor('en');
      final handle = tester.ensureSemantics();
      await pump(
        tester,
        const FeedbackHistoryScreen(),
        service: MockFeedbackHistoryService(rows: [row()], baseline: null),
      );

      // Several rows can share a label, so the spoken one names the row.
      expect(
        find.bySemanticsLabel(
          l10n.feedbackRevokeSemantics(
            '${l10n.feedbackObservedDefer} '
            '${l10n.feedbackHistoryAboutItem('Weekly Meal Prep')}',
          ),
        ),
        findsOneWidget,
      );
      handle.dispose();
    });
  });

  group('feedback history — when there is nothing to show', () {
    testWidgets('an unconnected record is never dressed up as an empty one', (
      tester,
    ) async {
      final l10n = l10nFor('en');
      await pump(
        tester,
        const FeedbackHistoryScreen(),
        service: MockFeedbackHistoryService(unavailable: true),
      );

      expect(find.text(l10n.feedbackHistoryUnavailableTitle), findsOneWidget);
      // "We learned nothing about you" would be the wrong claim here.
      expect(find.text(l10n.feedbackHistoryEmptyTitle), findsNothing);
    });

    testWidgets('a genuinely empty record says so', (tester) async {
      final l10n = l10nFor('en');
      await pump(
        tester,
        const FeedbackHistoryScreen(),
        service: MockFeedbackHistoryService(rows: [], baseline: null),
      );

      expect(find.text(l10n.feedbackHistoryEmptyTitle), findsOneWidget);
      expect(find.text(l10n.feedbackHistoryUnavailableTitle), findsNothing);
    });

    testWidgets('a read failure offers a retry', (tester) async {
      final l10n = l10nFor('en');
      await pump(
        tester,
        const FeedbackHistoryScreen(),
        service: MockFeedbackHistoryService(failWith: StateError('offline')),
      );

      expect(find.text(l10n.feedbackHistoryLoadFailedTitle), findsOneWidget);
      expect(find.text(l10n.retryAction), findsWidgets);
    });
  });

  group('feedback history — localization and direction', () {
    for (final code in ['ar', 'he']) {
      testWidgets('renders right-to-left in $code', (tester) async {
        final l10n = l10nFor(code);
        await pump(
          tester,
          const FeedbackHistoryScreen(),
          service: MockFeedbackHistoryService(rows: [row()], baseline: null),
          locale: Locale(code),
        );

        expect(find.text(l10n.feedbackObservedDefer), findsOneWidget);
        expect(find.text(l10n.feedbackRevokeAction), findsOneWidget);
        expect(
          Directionality.of(tester.element(find.text(l10n.feedbackObservedDefer))),
          TextDirection.rtl,
        );
      });
    }

    testWidgets('every new key is translated in all three locales', (
      tester,
    ) async {
      final en = l10nFor('en');
      for (final code in ['ar', 'he']) {
        final other = l10nFor(code);
        final pairs = <String, List<String>>{
          'feedbackHistoryTitle': [en.feedbackHistoryTitle, other.feedbackHistoryTitle],
          'feedbackHistoryIntro': [en.feedbackHistoryIntro, other.feedbackHistoryIntro],
          'feedbackRevokeAction': [en.feedbackRevokeAction, other.feedbackRevokeAction],
          'feedbackRevokedBadge': [en.feedbackRevokedBadge, other.feedbackRevokedBadge],
          'feedbackRevokeDoneMessage': [
            en.feedbackRevokeDoneMessage,
            other.feedbackRevokeDoneMessage,
          ],
          'feedbackHistoryUnavailableMessage': [
            en.feedbackHistoryUnavailableMessage,
            other.feedbackHistoryUnavailableMessage,
          ],
          'feedbackBaselineMessage': [
            en.feedbackBaselineMessage,
            other.feedbackBaselineMessage,
          ],
          'feedbackHistorySubjectUnknown': [
            en.feedbackHistorySubjectUnknown,
            other.feedbackHistorySubjectUnknown,
          ],
          'privacyRealControlsMessage': [
            en.privacyRealControlsMessage,
            other.privacyRealControlsMessage,
          ],
        };
        pairs.forEach((key, values) {
          // A key that falls through to English is an untranslated key, not a
          // translation that happens to match.
          expect(
            values[1].isNotEmpty && values[1] != values[0],
            isTrue,
            reason: '$key is not translated in $code',
          );
        });
      }
    });
  });

  group('privacy screen — controls that do what they say', () {
    Future<void> pumpPrivacy(WidgetTester tester, {Locale? locale}) async {
      tester.view.physicalSize = const Size(420 * 3, 1600 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final router = GoRouter(
        initialLocation: '/settings/privacy',
        routes: [
          GoRoute(
            path: '/settings/privacy',
            builder: (context, state) => const PrivacyScreen(),
            routes: [
              GoRoute(
                path: 'feedback-history',
                builder: (context, state) => const FeedbackHistoryScreen(),
              ),
            ],
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            feedbackHistoryServiceProvider.overrideWithValue(
              MockFeedbackHistoryService(),
            ),
            feedbackSubjectTitlesProvider.overrideWithValue(titles),
          ],
          child: MaterialApp.router(
            locale: locale,
            supportedLocales: AppLocalizations.supportedLocales,
            localizationsDelegates: const [
              AppLocalizations.delegate,
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            routerConfig: router,
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('holds no switch that is wired to nothing', (tester) async {
      await pumpPrivacy(tester);

      // The encryption and analytics switches were `onChanged: (_) {}`. A
      // control that cannot change anything is not a control.
      expect(find.byType(MaybesitterSwitch), findsNothing);
      expect(find.byType(Switch), findsNothing);
    });

    testWidgets('no longer claims to have deleted data it did not delete', (
      tester,
    ) async {
      final l10n = l10nFor('en');
      await pumpPrivacy(tester);

      expect(find.text(l10n.deleteAllDataAction), findsNothing);
      expect(find.text(l10n.dataClearedMessage), findsNothing);
      // Deletion is real and lives where it can act on the server.
      expect(find.text(l10n.privacyOpenTrustCenterAction), findsOneWidget);
    });

    testWidgets('reaches the feedback history screen', (tester) async {
      final l10n = l10nFor('en');
      await pumpPrivacy(tester);

      expect(find.text(l10n.feedbackHistoryEntryTitle), findsOneWidget);
      await tester.tap(find.text(l10n.feedbackHistoryEntryTitle));
      await tester.pumpAndSettle();

      expect(find.text(l10n.feedbackHistoryIntro), findsOneWidget);
    });

    testWidgets('renders right-to-left in Arabic', (tester) async {
      final l10n = l10nFor('ar');
      await pumpPrivacy(tester, locale: const Locale('ar'));

      expect(find.text(l10n.privacyStorageTitle), findsOneWidget);
      expect(
        Directionality.of(tester.element(find.text(l10n.privacyStorageTitle))),
        TextDirection.rtl,
      );
    });
  });
}

/// A record that reads fine and refuses every correction.
class _FailingRevokeService extends MockFeedbackHistoryService {
  _FailingRevokeService({required super.rows}) : super(baseline: null);

  @override
  Future<FeedbackHistoryRow> revoke(String eventId) async {
    throw const FeedbackHistoryUnavailableException();
  }
}
