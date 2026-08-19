import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/calendar_import.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/calendar_conflict_detector.dart';

void main() {
  test('detects overlaps between imported busy blocks and commitments', () {
    final summary = summarizeCalendarConflicts(
      commitments: [
        Commitment(
          id: 'c-1',
          title: 'Clinic call',
          scheduledDate: DateTime(2026, 8, 20),
          startTime: '09:30 AM',
          endTime: '10:00 AM',
        ),
        Commitment(
          id: 'c-2',
          title: 'Groceries',
          scheduledDate: DateTime(2026, 8, 20),
          startTime: '01:00 PM',
          endTime: '02:00 PM',
        ),
      ],
      calendar: CalendarImportSnapshot(
        provider: CalendarImportProvider.appleCalendar,
        connectionState: CalendarImportConnectionState.connected,
        retainedBusyBlocks: [
          ImportedCalendarBusyBlock(
            id: 'event-1',
            startAt: DateTime(2026, 8, 20, 9),
            endAt: DateTime(2026, 8, 20, 11),
            allDay: false,
          ),
        ],
      ),
    );

    expect(summary.commitmentCount, 1);
    expect(summary.busyBlockCount, 1);
  });

  test('ignores imported data while disconnected', () {
    final summary = summarizeCalendarConflicts(
      commitments: [
        Commitment(
          id: 'c-1',
          title: 'Clinic call',
          scheduledDate: DateTime(2026, 8, 20),
          startTime: '09:30 AM',
          endTime: '10:00 AM',
        ),
      ],
      calendar: CalendarImportSnapshot(
        provider: CalendarImportProvider.appleCalendar,
        connectionState: CalendarImportConnectionState.disconnected,
        retainedBusyBlocks: [
          ImportedCalendarBusyBlock(
            id: 'event-1',
            startAt: DateTime(2026, 8, 20, 9),
            endAt: DateTime(2026, 8, 20, 11),
            allDay: false,
          ),
        ],
      ),
    );

    expect(summary.hasConflicts, isFalse);
  });
}
