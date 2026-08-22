import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/commitment_details/commitment_details_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/activity_event.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
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
        // Advance to tomorrow rather than keeping today's date. editTime()
        // rejects any combined date+time that isn't after DateTime.now(), so
        // picking today's date and a fixed clock time (3:45 PM below) would
        // flake depending on what time of day the suite happens to run -
        // failing whenever the real clock is already past 3:45 PM. Tomorrow
        // is unconditionally in the future regardless of wall-clock time.
        final dateEntryModeButton = find.descendant(
          of: find.byType(DatePickerDialog),
          matching: find.byIcon(Icons.edit_outlined),
        );
        expect(dateEntryModeButton, findsOneWidget);
        await tester.tap(dateEntryModeButton);
        await tester.pumpAndSettle();
        final tomorrow = DateTime.now().add(const Duration(days: 1));
        final dateInputField = find.byType(TextField);
        expect(dateInputField, findsOneWidget);
        await tester.enterText(
          dateInputField,
          '${tomorrow.month.toString().padLeft(2, '0')}/'
          '${tomorrow.day.toString().padLeft(2, '0')}/'
          '${tomorrow.year}',
        );
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

        // The dial defaults its selection to `initialTime` (the
        // commitment's *current* time), so simply confirming it would be a
        // same-value no-op. Switch to text input mode and type an
        // unambiguous new time instead - this reliably drives a real value
        // change through the exact widget the app shows.
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
          '03:45 PM',
        );
      },
    );

    testWidgets(
      'picking a time in the past is rejected and nothing changes',
      (WidgetTester tester) async {
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

        expect(find.textContaining('10:30 AM'), findsOneWidget);

        await tester.tap(find.byIcon(Icons.schedule));
        await tester.pumpAndSettle();

        // Pick a date safely in the past (well before today, so it stays
        // in the past regardless of what wall-clock time the suite runs
        // at) via the date picker's text input mode - the calendar grid
        // can only reach dates the visible month page shows, but typed
        // input accepts any date within firstDate/lastDate.
        //
        // Icons.edit_outlined also appears on the app bar's title-edit
        // button, so scope the finder to inside the DatePickerDialog.
        final dateEntryModeButton = find.descendant(
          of: find.byType(DatePickerDialog),
          matching: find.byIcon(Icons.edit_outlined),
        );
        expect(dateEntryModeButton, findsOneWidget);
        await tester.tap(dateEntryModeButton);
        await tester.pumpAndSettle();

        final pastYear = DateTime.now().year - 1;
        await tester.enterText(
          find.byType(TextField).first,
          '01/01/$pastYear',
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();

        // A date a year in the past is always before "now" regardless of
        // what time is picked, so any confirmed time keeps the combined
        // DateTime in the past - the guard must fire before either
        // repository call, without needing to also drive the time
        // picker's dial to a specific value.
        expect(find.byType(TimePickerDialog), findsOneWidget);
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();

        expect(
          find.textContaining('Please choose a time in the future'),
          findsOneWidget,
          reason:
              'Picking a past date/time must surface the rejection message, '
              'not silently proceed.',
        );

        // Nothing must have changed: no postpone, no status flip, no
        // display update - the guard runs before either repository call.
        expect(find.textContaining('10:30 AM'), findsOneWidget);
        expect(find.textContaining('Postponed'), findsNothing);
        final restored = container
            .read(commitmentsStreamProvider)
            .value!
            .firstWhere((c) => c.id == 'c-today-1');
        expect(restored.startTime, '10:30 AM');
        expect(restored.status, CommitmentStatus.pending);
      },
    );

    testWidgets(
      'editing the time does not mark the commitment postponed',
      (WidgetTester tester) async {
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

        await tester.tap(find.byIcon(Icons.schedule));
        await tester.pumpAndSettle();
        await tester.tap(find.descendant(
          of: find.byType(DatePickerDialog),
          matching: find.byIcon(Icons.edit_outlined),
        ));
        await tester.pumpAndSettle();
        final tomorrow = DateTime.now().add(const Duration(days: 1));
        await tester.enterText(
          find.byType(TextField),
          '${tomorrow.month.toString().padLeft(2, '0')}/'
          '${tomorrow.day.toString().padLeft(2, '0')}/'
          '${tomorrow.year}',
        );
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();

        await tester.tap(find.byIcon(Icons.keyboard_outlined));
        await tester.pumpAndSettle();
        final timeFields = find.byType(TextField);
        await tester.enterText(timeFields.first, '03');
        await tester.enterText(timeFields.last, '45');
        final pm = find.text('PM');
        if (tester.any(pm)) {
          await tester.tap(pm);
          await tester.pumpAndSettle();
        }
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();

        final stored =
            await container.read(commitmentRepositoryProvider).getById('c-today-1');
        expect(
          stored?.status,
          CommitmentStatus.pending,
          reason: 'correcting a time is not the same act as postponing',
        );
        expect(stored?.startTime, '03:45 PM');

        final activity = await container.read(activityRepositoryProvider).getActivity();
        expect(
          activity.where((e) => e.type == ActivityEventType.commitmentPostponed),
          isEmpty,
          reason: 'a time edit wrote a "Postponed" entry to Activity',
        );
      },
    );
  });
}
