import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/commitment_details/commitment_details_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/services/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Exercises mock-mode-specific behaviour (the in-memory commitment
/// repository's seed data), matching the pattern used by the equivalent
/// title-edit regression in `lane_a_reliability_test.dart`.
ProviderContainer _buildMockModeContainer() {
  return ProviderContainer(
    overrides: [
      appConfigProvider.overrideWith(
        (ref) => const AppConfig(apiMode: ApiMode.mock),
      ),
    ],
  );
}

Widget _buildLocalizedApp(Widget home) {
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
  group('CommitmentDetailsScreen time edit', () {
    testWidgets(
      'tapping the time field opens a time picker and updates the displayed time',
      (WidgetTester tester) async {
        // editTime() persists via the repository's postpone(), which (unlike
        // update(), used by the sibling title-edit test) calls _persist() -
        // a real SharedPreferences platform-channel call. Without mock
        // initial values, that call never resolves under flutter_test,
        // silently hanging postpone()'s Future forever.
        SharedPreferences.setMockInitialValues({});

        final container = _buildMockModeContainer();
        addTearDown(container.dispose);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: _buildLocalizedApp(
              const CommitmentDetailsScreen(id: 'c-today-1'),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // Seed data (in_memory_commitment_repository.dart): c-today-1 has
        // startTime '10:30 AM', endTime '11:15 AM', so the Time row renders
        // as a range. DateFormatter.formatTimeRange wraps each token (and
        // the whole range) in Unicode directional-isolate marks for bidi
        // safety, so an exact find.text would never match - use
        // textContaining instead, same as the rendered substring.
        expect(find.textContaining('10:30 AM'), findsOneWidget);
        expect(find.textContaining('11:15 AM'), findsOneWidget);

        // Tap the Time ListTile (identified by its leading icon, the same
        // way the Edit affordance is targeted in the sibling title-edit
        // test) - there is no picker at all yet, so this must now open one.
        await tester.tap(find.byIcon(Icons.schedule));
        await tester.pumpAndSettle();

        // editTime() opens the date picker first (AdaptiveDateTimePicker.
        // pickDate), then the time picker (pickTime). Material
        // (non-Cupertino, the default in the test environment) renders
        // showDatePicker as a DatePickerDialog with an "OK" confirm action.
        expect(
          find.byType(DatePickerDialog),
          findsOneWidget,
          reason:
              'Tapping the Time row must open a picker, not do nothing.',
        );
        // Keep the same date - only the time is under test here.
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();

        // Material (non-Cupertino in the test environment): showTimePicker's
        // dial renders a Material TimePickerDialog with an "OK" confirm
        // action.
        expect(
          find.byType(TimePickerDialog),
          findsOneWidget,
          reason: 'Confirming the date must lead into a time picker.',
        );

        // Drive the picker's dial to a new time via its Input entry mode is
        // fiddly to simulate; instead confirm the picker with its default
        // initial selection is NOT what we assert on - select via the
        // widget's public API isn't exposed, so we cancel this run and
        // instead verify the affordance opens correctly. The actual value
        // change is verified below by calling through the same code path
        // the UI uses (tapping OK keeps whatever the dial shows, and the
        // Flutter TimePickerDialog defaults its dial to the `initialTime`
        // passed in - i.e. the commitment's *current* time - so simply
        // confirming would be a same-value no-op assertion).
        //
        // Instead, switch the dialog to text input mode, type an
        // unambiguous new time, and confirm - this reliably drives a real
        // value change through the exact widget the app shows.
        final entryModeButton = find.byIcon(Icons.keyboard_outlined);
        expect(entryModeButton, findsOneWidget);
        await tester.tap(entryModeButton);
        await tester.pumpAndSettle();

        // Material time input mode shows separate hour/minute text fields.
        final timeInputFields = find.byType(TextField);
        expect(timeInputFields, findsNWidgets(2));
        await tester.enterText(timeInputFields.first, '03');
        await tester.enterText(timeInputFields.last, '45');
        // Material's time input defaults to AM/PM period buttons; select PM
        // explicitly so the resulting time is unambiguous.
        final pmButton = find.text('PM');
        if (tester.any(pmButton)) {
          await tester.tap(pmButton);
          await tester.pumpAndSettle();
        }

        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();

        expect(
          find.textContaining('3:45 PM'),
          findsOneWidget,
          reason: 'Confirming a new time must update the displayed time.',
        );
        expect(
          find.textContaining('10:30 AM'),
          findsNothing,
          reason: 'The stale start time must no longer be displayed.',
        );

        expect(
          container
              .read(commitmentsStreamProvider)
              .value!
              .firstWhere((c) => c.id == 'c-today-1')
              .startTime,
          '3:45 PM',
        );
      },
    );
  });
}
