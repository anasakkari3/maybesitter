import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/providers.dart';

void main() {
  testWidgets('Integration Test: Full Capture and Postpone Demonstration Flow', (
    WidgetTester tester,
  ) async {
    final container = ProviderContainer();

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaybesitterApp(),
      ),
    );
    await tester.pump();
    await tester.pumpAndSettle();

    // 1. Verify Home screen loads
    expect(find.text('Maybesitter'), findsOneWidget);

    // 2. Open Capture Composer
    final captureFab = find.byType(FloatingActionButton).first;
    expect(captureFab, findsOneWidget);
    await tester.tap(captureFab);
    await tester.pumpAndSettle();

    // 3. Verify Composer is open with default text
    expect(find.text('New Intent'), findsOneWidget);

    // 4. Tap Analyze button
    final analyzeBtn = find.text('Analyze');
    expect(analyzeBtn, findsOneWidget);
    await tester.tap(analyzeBtn);
    await tester.pump(const Duration(milliseconds: 1000));
    await tester.pumpAndSettle();

    // 5. Verify Extraction Review screen shows exactly 2 proposed commitments
    expect(find.text('Review Your Plan'), findsOneWidget);
    expect(find.text('Go to the doctor'), findsOneWidget);
    expect(find.text('Work afterward'), findsOneWidget);

    // 6. Confirm commitments
    final confirmBtn = find.textContaining('Confirm 2 Commitments');
    expect(confirmBtn, findsOneWidget);
    await tester.tap(confirmBtn);
    await tester.pumpAndSettle();

    // 7. Verify Success Save screen
    expect(find.text('Added 2 commitments for tomorrow.'), findsOneWidget);

    // 8. Navigate to Upcoming screen
    final viewTomorrowBtn = find.text('View Tomorrow');
    expect(viewTomorrowBtn, findsOneWidget);
    await tester.tap(viewTomorrowBtn);
    await tester.pump();
    await tester.pumpAndSettle();

    // 9. Verify commitments exist on Upcoming screen
    expect(find.text('Upcoming Agenda'), findsOneWidget);
    final doctorCard = find.text('Go to the doctor');
    expect(doctorCard, findsOneWidget);

    // 10. Verify Repository State after saving (3 seeded + 2 newly captured = 5 total)
    final repo = container.read(commitmentRepositoryProvider);
    final initialUpcoming = await repo.getUpcoming();
    expect(initialUpcoming.length, 5);

    final doctorInitial = initialUpcoming.firstWhere(
      (c) => c.title == 'Go to the doctor',
    );
    final workInitial = initialUpcoming.firstWhere(
      (c) => c.title == 'Work afterward',
    );

    final originalDoctorDate = doctorInitial.scheduledDate;
    final originalWorkDate = workInitial.scheduledDate;

    // 11. Open Commitment Details for "Go to the doctor"
    await tester.tap(doctorCard);
    await tester.pump();
    await tester.pumpAndSettle();

    expect(find.text('Commitment Detail'), findsOneWidget);

    // 12. Scroll and Open Postpone Sheet
    final postponeBtn = find.text('Postpone Commitment');
    expect(postponeBtn, findsOneWidget);
    await tester.ensureVisible(postponeBtn);
    await tester.pumpAndSettle();

    await tester.tap(postponeBtn);
    await tester.pumpAndSettle();

    // 13. Select "Next Week" postponement option
    final nextWeekOpt = find.text('Next Week');
    expect(nextWeekOpt, findsOneWidget);
    await tester.tap(nextWeekOpt);
    await tester.pump();
    await tester.pumpAndSettle();

    // 14. Verify Repository Invariants After Postponement
    final updatedUpcoming = await repo.getUpcoming();

    // Invariant A: Total count remains exactly 5 (no duplicate or phantom commitment created)
    expect(updatedUpcoming.length, 5);

    final doctorUpdated = await repo.getById(doctorInitial.id);
    final workUpdated = await repo.getById(workInitial.id);

    expect(doctorUpdated, isNotNull);
    expect(workUpdated, isNotNull);

    // Invariant B: Doctor commitment ID remains identical
    expect(doctorUpdated!.id, equals(doctorInitial.id));

    // Invariant C: Doctor commitment date has updated to future postponed date
    expect(doctorUpdated.scheduledDate.isAfter(originalDoctorDate), isTrue);
    expect(doctorUpdated.status, equals(CommitmentStatus.postponed));

    // Invariant D: Work commitment date and status remain unchanged
    expect(workUpdated!.scheduledDate, equals(originalWorkDate));
    expect(workUpdated.id, equals(workInitial.id));
  });
}
