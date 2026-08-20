/// Correcting what the reader got wrong.
///
/// Extraction guesses. When it guesses wrong -- and it will -- the person needs
/// a way to say so before saving. The review screen used to offer a single
/// title field, so a misread hour or priority could not be corrected at all,
/// and there was no date or time picker anywhere in the app.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/capture/commitment_edit_sheet.dart';
import 'package:maybesitter_mobile/models/commitment.dart';

final _original = Commitment(
  id: 'c1',
  title: 'أنزل على الشغل',
  scheduledDate: DateTime(2026, 8, 22),
  startTime: '05:00',
  priority: CommitmentPriority.should,
);

void main() {
  group('the edit carries every field, not only the title', () {
    test('a new title replaces the old one', () {
      final edited = applyCommitmentEdit(
        _original,
        title: 'أنزل على المكتب',
      );

      expect(edited.title, 'أنزل على المكتب');
      expect(edited.startTime, '05:00', reason: 'untouched fields survive');
    });

    test('a corrected hour replaces the misread one', () {
      final edited = applyCommitmentEdit(_original, startTime: '17:00');

      expect(edited.startTime, '17:00');
    });

    test('a corrected date replaces the assumed one', () {
      final edited = applyCommitmentEdit(
        _original,
        scheduledDate: DateTime(2026, 8, 25),
      );

      expect(edited.scheduledDate, DateTime(2026, 8, 25));
    });

    test('a corrected priority replaces the guessed one', () {
      final edited = applyCommitmentEdit(
        _original,
        priority: CommitmentPriority.must,
      );

      expect(edited.priority, CommitmentPriority.must);
    });

    test('an empty title is refused rather than saved blank', () {
      final edited = applyCommitmentEdit(_original, title: '   ');

      expect(edited.title, 'أنزل على الشغل');
    });
  });

  group('clearing what was never said', () {
    test('the date can be removed entirely', () {
      final edited = applyCommitmentEdit(_original, clearDate: true);

      expect(edited.scheduledDate, isNull);
    });

    test('the time can be removed entirely', () {
      final edited = applyCommitmentEdit(_original, clearTime: true);

      expect(edited.startTime, isNull);
    });

    test('clearing the date does not clear the time', () {
      final edited = applyCommitmentEdit(_original, clearDate: true);

      expect(edited.startTime, '05:00');
    });
  });

  group('editing settles the clarification', () {
    test('a reviewed commitment no longer asks for clarification', () {
      final unclear = _original.copyWith(needsClarification: true);

      final edited = applyCommitmentEdit(unclear, title: 'واضح الآن');

      expect(edited.needsClarification, isFalse);
    });
  });
}
