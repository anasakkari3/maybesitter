/// What the user sees when the two models read a sentence differently.
///
/// Picking one silently would make a model's guess look like a fact, which
/// the product forbids. When they disagree the user chooses.
///
/// Two readings can also disagree without disagreeing about *how many*
/// commitments there are: the arbitration verdict carries `correctedTimes`,
/// so "work at five, gym at seven" and "work at five, gym at seven in the
/// evening" are two commitments either way and still a real dispute. The
/// fixtures below are colloquial Arabic and Hebrew because those are the
/// readings the local model is weakest at, and therefore the ones that
/// actually reach this code.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/capture/split_choice.dart';
import 'package:maybesitter_mobile/models/commitment.dart';

Commitment _c(
  String id,
  String title, {
  DateTime? at,
  String? clock,
  TimeGranularity granularity = TimeGranularity.exact,
}) => Commitment(
  id: id,
  title: title,
  priority: CommitmentPriority.should,
  scheduledDate: at,
  startTime: clock,
  timeGranularity: granularity,
);

void main() {
  group('no remote reading', () {
    test('with no remote answer the local split stands, no choice needed', () {
      final choice = buildSplitChoice(
        local: [_c('1', 'أنزل عالشغل'), _c('2', 'أروح عالنادي')],
      );

      expect(choice.needsUserChoice, isFalse);
      expect(choice.options.single.source, SplitSource.agreed);
      expect(choice.options.single.commitments, hasLength(2));
    });
  });

  group('genuine agreement', () {
    test('an agreeing remote answer needs no choice', () {
      final choice = buildSplitChoice(
        local: [_c('1', 'להגיע למשרד'), _c('2', 'חדר כושר')],
        remote: [_c('1', 'להגיע למשרד'), _c('2', 'חדר כושר')],
      );

      expect(choice.needsUserChoice, isFalse);
      expect(choice.options.single.source, SplitSource.agreed);
    });

    test('the same clock written differently is still agreement', () {
      // '7:00' and '07:00' are the same claim. Formatting is not a dispute,
      // and asking the user to arbitrate one would train them to tap through.
      final choice = buildSplitChoice(
        local: [_c('1', 'أمرّ على أمي', clock: '7:00')],
        remote: [_c('1', 'أمرّ على أمي', clock: '07:00')],
      );

      expect(choice.needsUserChoice, isFalse);
    });

    test('silence about the time is not a competing claim', () {
      // The arbiter may correct only the count and return no times at all.
      // Reading its silence as "no time" would fire a dispute on every
      // count-only verdict.
      final choice = buildSplitChoice(
        local: [_c('1', 'أدفع فاتورة الكهربا', at: DateTime(2026, 8, 22, 17))],
        remote: [_c('1', 'أدفع فاتورة الكهربا')],
      );

      expect(choice.needsUserChoice, isFalse);
    });

    test('a reworded title alone is not a disagreement', () {
      // Deliberate boundary: the user can retitle a commitment in the review
      // screen, but cannot recover a split or a time the app never offered.
      // Only count and time are worth interrupting for.
      final choice = buildSplitChoice(
        local: [_c('1', 'آخد الولاد من المدرسة', clock: '14:00')],
        remote: [_c('1', 'الولاد', clock: '14:00')],
      );

      expect(choice.needsUserChoice, isFalse);
    });
  });

  group('different commitment count', () {
    test('a different count is offered as two options', () {
      final choice = buildSplitChoice(
        local: [_c('1', 'أنزل عالشغل وبعدها النادي')],
        remote: [_c('1', 'أنزل عالشغل'), _c('2', 'أروح عالنادي')],
      );

      expect(choice.needsUserChoice, isTrue);
      expect(choice.options, hasLength(2));
      expect(choice.options.map((o) => o.source), [
        SplitSource.localOnly,
        SplitSource.remoteOnly,
      ]);
    });
  });

  group('same count, materially different time', () {
    test('the same count with a different clock time is a disagreement', () {
      // Both readings find two commitments; they disagree about whether
      // "على السبعة" is seven in the morning or seven in the evening. The
      // count check alone would ship the local guess silently.
      final local = [
        _c('1', 'أنزل عالشغل', at: DateTime(2026, 8, 22, 5), clock: '05:00'),
        _c('2', 'أروح عالنادي', at: DateTime(2026, 8, 22, 7), clock: '07:00'),
      ];
      final remote = [
        _c('1', 'أنزل عالشغل', at: DateTime(2026, 8, 22, 5), clock: '05:00'),
        _c('2', 'أروح عالنادي', at: DateTime(2026, 8, 22, 19), clock: '19:00'),
      ];

      final choice = buildSplitChoice(local: local, remote: remote);

      expect(choice.needsUserChoice, isTrue);
      expect(choice.options, hasLength(2));
      // Local is passed through untouched; the remote list is rebuilt by the
      // usability filter, so it is the commitments that must survive, not the
      // list object.
      expect(choice.options.first.commitments, same(local));
      expect(choice.options.last.commitments, equals(remote));
    });

    test('the same count on a different day is a disagreement', () {
      final choice = buildSplitChoice(
        local: [_c('1', 'להתקשר לאמא', at: DateTime(2026, 8, 22, 8))],
        remote: [_c('1', 'להתקשר לאמא', at: DateTime(2026, 8, 23, 8))],
      );

      expect(choice.needsUserChoice, isTrue);
    });

    test('a clock claim against a date-only reading is a disagreement', () {
      // One reading pins 16:00, the other says only "that day". Those are
      // different schedules, so the user picks.
      final choice = buildSplitChoice(
        local: [
          _c('1', 'לאסוף את הילדים', at: DateTime(2026, 8, 22, 16),
              clock: '16:00'),
        ],
        remote: [
          _c('1', 'לאסוף את הילדים', at: DateTime(2026, 8, 22, 9),
              clock: '09:00'),
        ],
      );

      expect(choice.needsUserChoice, isTrue);
    });
  });

  group('empty or invalid remote reading', () {
    test('an empty remote answer is ignored rather than shown as a choice', () {
      final choice = buildSplitChoice(
        local: [_c('1', 'أنزل عالشغل')],
        remote: const [],
      );

      expect(choice.needsUserChoice, isFalse);
      expect(choice.options.single.source, SplitSource.agreed);
    });

    test('a remote answer of blank titles is ignored', () {
      final choice = buildSplitChoice(
        local: [_c('1', 'أنزل عالשגל'), _c('2', 'أروح عالنادي')],
        remote: [_c('1', ''), _c('2', '   ')],
      );

      expect(choice.needsUserChoice, isFalse);
      expect(choice.options.single.commitments, hasLength(2));
    });

    test('a blank remote entry is dropped, never offered as a commitment', () {
      // A titleless commitment is not a reading the user can choose between,
      // so it must not survive into an option or inflate the count.
      final choice = buildSplitChoice(
        local: [_c('1', 'להגיע למשרד')],
        remote: [_c('1', 'להגיע למשרד'), _c('2', '')],
      );

      expect(choice.needsUserChoice, isFalse);
      expect(
        choice.options.expand((o) => o.commitments).map((c) => c.title),
        everyElement(isNotEmpty),
      );
    });
  });

  group('ordering', () {
    test('the local reading is offered first, whatever its shape', () {
      final disputes = <List<List<Commitment>>>[
        // Remote splits further than local.
        [
          [_c('1', 'أنزل عالشغل وبعدها النادي')],
          [_c('1', 'أنزل عالشغل'), _c('2', 'أروح عالنادي')],
        ],
        // Remote merges what local split — local is the longer list here, so
        // the order cannot be an accident of length.
        [
          [_c('1', 'להגיע למשרד'), _c('2', 'חדר כושר')],
          [_c('1', 'להגיע למשרד וחדר כושר')],
        ],
        // Same count, different time.
        [
          [_c('1', 'pick up the kids', clock: '14:00')],
          [_c('1', 'pick up the kids', clock: '16:00')],
        ],
      ];

      for (final dispute in disputes) {
        final choice = buildSplitChoice(local: dispute[0], remote: dispute[1]);

        // The local answer is what the device produced without sending
        // anything, so it is the one that gets read first.
        expect(choice.options.first.source, SplitSource.localOnly);
        expect(choice.options.first.commitments, same(dispute[0]));
      }
    });
  });

  group('a disputed reading never becomes the single silent answer', () {
    test('every dispute yields two labelled options and no agreed option', () {
      final disputes = <List<List<Commitment>>>[
        [
          [_c('1', 'أنزل عالشغل وبعدها النادي')],
          [_c('1', 'أنزل عالشغل'), _c('2', 'أروح عالنادي')],
        ],
        [
          [_c('1', 'أروح عالنادي', clock: '07:00')],
          [_c('1', 'أروح عالنادي', clock: '19:00')],
        ],
        [
          [_c('1', 'להתקשר לאמא', at: DateTime(2026, 8, 22, 8))],
          [_c('1', 'להתקשר לאמא', at: DateTime(2026, 8, 23, 8))],
        ],
      ];

      for (final dispute in disputes) {
        final choice = buildSplitChoice(local: dispute[0], remote: dispute[1]);

        expect(choice.needsUserChoice, isTrue);
        expect(choice.options, hasLength(2));
        expect(
          choice.options.map((o) => o.source),
          isNot(contains(SplitSource.agreed)),
          reason: 'a dispute must never be labelled as agreement',
        );
        expect(
          choice.options.map((o) => o.commitments),
          containsAll(<Object>[equals(dispute[0]), equals(dispute[1])]),
          reason: 'both readings must reach the user, neither one alone',
        );
      }
    });

    test('needing a choice and having a single answer are exclusive', () {
      final disputed = buildSplitChoice(
        local: [_c('1', 'أمرّ على أمي', clock: '17:00')],
        remote: [_c('1', 'أمرّ على أمي', clock: '20:00')],
      );
      final settled = buildSplitChoice(local: [_c('1', 'أمرّ على أمي')]);

      // `options.single` is how a caller reads "the answer". It must throw
      // for a dispute, so no call site can accidentally take one side.
      expect(() => disputed.options.single, throwsStateError);
      expect(settled.options.single.source, SplitSource.agreed);
    });
  });
}
