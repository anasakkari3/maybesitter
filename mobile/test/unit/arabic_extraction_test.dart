/// Reading what a person actually wrote.
///
/// Built from the sentence that exposed the stub: three commitments in one
/// breath, two clock times, and two different levels of insistence. The mock
/// this replaces returned one item, tomorrow, 10:00, "should" -- the same
/// answer for every input, having read none of it.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/rule_based_extractor.dart';

final _now = DateTime(2026, 8, 21, 12);

List<Commitment> _extract(String text) =>
    const RuleBasedExtractor().extract(text, now: _now);

void main() {
  group('the sentence that started this', () {
    const text =
        'بكرة الصبح بدي أنزل على الشغل على الخمسة '
        'لازم أكون بالنادي على السبعة '
        'لازم أكون بالمكتب';

    test('three intentions become three commitments', () {
      expect(_extract(text), hasLength(3));
    });

    test('each clock time lands on its own commitment', () {
      final items = _extract(text);

      expect(items[0].startTime, '05:00');
      expect(items[1].startTime, '07:00');
    });

    test('"لازم" is a must and "بدي" is not', () {
      final items = _extract(text);

      expect(items[0].priority, CommitmentPriority.should);
      expect(items[1].priority, CommitmentPriority.must);
      expect(items[2].priority, CommitmentPriority.must);
    });

    test('"بكرة" puts all three on tomorrow', () {
      for (final item in _extract(text)) {
        expect(item.scheduledDate?.day, 22);
      }
    });

    test('the title is what to do, not the whole sentence', () {
      final items = _extract(text);

      expect(items[0].title, 'أنزل على الشغل');
      expect(items[1].title, 'أكون بالنادي');
      expect(items[2].title, 'أكون بالمكتب');
    });
  });

  group('times', () {
    test('reads an Arabic-Indic hour', () {
      expect(_extract('لازم أروح النادي الساعة ٥ مساء').single.startTime, '17:00');
    });

    test('reads a spelled-out hour', () {
      expect(_extract('لازم أكون بالمكتب على التاسعة').single.startTime, '09:00');
    });

    test('reads minutes', () {
      expect(_extract('موعد الطبيب الساعة 10:30').single.startTime, '10:30');
    });

    test('evening pushes the hour past noon', () {
      expect(_extract('لازم أروح على السابعة مساء').single.startTime, '19:00');
    });

    test('a bare part of day becomes a sensible hour', () {
      expect(_extract('بدي أدرس بكرة المسا').single.startTime, '18:00');
    });
  });

  group('dates', () {
    test('اليوم is today', () {
      expect(_extract('لازم أتصل بأحمد اليوم').single.scheduledDate?.day, 21);
    });

    test('بعد بكرا is the day after tomorrow', () {
      expect(_extract('موعد بعد بكرا').single.scheduledDate?.day, 23);
    });

    test('no date mentioned leaves the date unset rather than inventing one', () {
      expect(_extract('لازم أجدد التأمين').single.scheduledDate, isNull);
    });
  });

  group('insistence', () {
    test('ضروري is a must', () {
      expect(
        _extract('ضروري أدفع الفاتورة بكرة').single.priority,
        CommitmentPriority.must,
      );
    });

    test('يمكن is only nice', () {
      expect(
        _extract('يمكن أقرأ فصل بكرة').single.priority,
        CommitmentPriority.nice,
      );
    });

    test('plain intent is a should', () {
      expect(
        _extract('بدي أشتري حليب بكرة').single.priority,
        CommitmentPriority.should,
      );
    });
  });

  group('English keeps working', () {
    test('reads an English commitment', () {
      final item = _extract('I must call Ahmad tomorrow at 3pm').single;

      expect(item.title, 'call Ahmad');
      expect(item.startTime, '15:00');
      expect(item.priority, CommitmentPriority.must);
    });
  });

  group('sequencing words separate intentions', () {
    test('"and then" in English', () {
      final items = _extract('Tomorrow I will go to the doctor and then work');

      expect(items, hasLength(2));
      expect(items[0].title, 'go to the doctor');
      expect(items[1].title, 'work');
    });

    test('"وبعدين" in Arabic', () {
      final items = _extract('بكرة بروح عالطبيب وبعدين على الشغل');

      expect(items, hasLength(2));
    });

    test('a lone "and" does not split a single thing', () {
      // "bread and milk" is one errand, not two.
      expect(_extract('لازم أشتري خبز وحليب بكرة'), hasLength(1));
    });
  });

  group('nothing to read', () {
    test('empty text yields nothing rather than a placeholder', () {
      expect(_extract('   '), isEmpty);
    });
  });
}
