import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:maybesitter_mobile/core/utilities/date_formatter.dart';
import 'package:maybesitter_mobile/core/utilities/l10n_extensions.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/app_settings.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/providers.dart';

void main() {
  group('Localization Unit Tests', () {
    late AppLocalizations l10nEn;
    late AppLocalizations l10nAr;
    late AppLocalizations l10nHe;

    setUpAll(() async {
      await initializeDateFormatting('en');
      await initializeDateFormatting('ar');
      await initializeDateFormatting('he');

      l10nEn = await AppLocalizations.delegate.load(const Locale('en'));
      l10nAr = await AppLocalizations.delegate.load(const Locale('ar'));
      l10nHe = await AppLocalizations.delegate.load(const Locale('he'));
    });

    test('Locale option enum properties', () {
      expect(AppLocaleOption.system.locale, isNull);
      expect(AppLocaleOption.english.locale, equals(const Locale('en')));
      expect(AppLocaleOption.arabic.locale, equals(const Locale('ar')));
      expect(AppLocaleOption.hebrew.locale, equals(const Locale('he')));
    });

    test('AppSettingsNotifier locale updates', () async {
      final notifier = AppSettingsNotifier();

      await notifier.updateLocale(AppLocaleOption.arabic);
      await notifier.updateLocale(AppLocaleOption.hebrew);
    });

    test('Priority localization across English, Arabic, and Hebrew', () {
      expect(CommitmentPriority.must.localizedName(l10nEn), equals('MUST'));
      expect(CommitmentPriority.must.localizedName(l10nAr), equals('ضروري'));
      expect(CommitmentPriority.must.localizedName(l10nHe), equals('חובה'));

      expect(CommitmentPriority.should.localizedName(l10nEn), equals('SHOULD'));
      expect(CommitmentPriority.should.localizedName(l10nAr), equals('مستحسن'));
      expect(CommitmentPriority.should.localizedName(l10nHe), equals('מומלץ'));

      expect(CommitmentPriority.nice.localizedName(l10nEn), equals('NICE'));
      expect(CommitmentPriority.nice.localizedName(l10nAr), equals('اختياري'));
      expect(CommitmentPriority.nice.localizedName(l10nHe), equals('רשות'));
    });

    test(
      'CommitmentStatus localization across English, Arabic, and Hebrew',
      () {
        expect(
          CommitmentStatus.pending.localizedStatusName(l10nEn),
          equals('Pending'),
        );
        expect(
          CommitmentStatus.pending.localizedStatusName(l10nAr),
          equals('قيد الانتظار'),
        );
        expect(
          CommitmentStatus.pending.localizedStatusName(l10nHe),
          equals('ממתין'),
        );

        expect(
          CommitmentStatus.completed.localizedStatusName(l10nEn),
          equals('Completed'),
        );
        expect(
          CommitmentStatus.completed.localizedStatusName(l10nAr),
          equals('مكتمل'),
        );
        expect(
          CommitmentStatus.completed.localizedStatusName(l10nHe),
          equals('הושלם'),
        );

        expect(
          CommitmentStatus.postponed.localizedStatusName(l10nEn),
          equals('Postponed'),
        );
        expect(
          CommitmentStatus.postponed.localizedStatusName(l10nAr),
          equals('مؤجل'),
        );
        expect(
          CommitmentStatus.postponed.localizedStatusName(l10nHe),
          equals('נגרר'),
        );
      },
    );

    test('Plurals formatting for 1, 2, and multiple commitments', () {
      expect(
        l10nEn.confirmCommitmentsAction(1),
        equals('Confirm 1 Commitment'),
      );
      expect(
        l10nEn.confirmCommitmentsAction(2),
        equals('Confirm 2 Commitments'),
      );
      expect(
        l10nEn.confirmCommitmentsAction(5),
        equals('Confirm 5 Commitments'),
      );

      expect(l10nAr.confirmCommitmentsAction(1), equals('تأكيد التزام واحد'));
      expect(l10nAr.confirmCommitmentsAction(2), equals('تأكيد التزامين'));
      expect(l10nAr.confirmCommitmentsAction(3), equals('تأكيد 3 التزامات'));

      expect(l10nHe.confirmCommitmentsAction(1), equals('אישור התחייבות אחת'));
      expect(
        l10nHe.confirmCommitmentsAction(2),
        equals('אישור שתי התחייבויות'),
      );
      expect(l10nHe.confirmCommitmentsAction(5), equals('אישור 5 התחייבויות'));
    });

    test('DateFormatter formatting with explicit locales', () {
      final date = DateTime(2026, 7, 28, 14, 30);
      final fullDateEn = DateFormatter.formatFullDate(date, locale: 'en');
      final fullDateAr = DateFormatter.formatFullDate(date, locale: 'ar');
      final fullDateHe = DateFormatter.formatFullDate(date, locale: 'he');

      expect(fullDateEn, contains('2026'));
      expect(fullDateAr, isNotEmpty);
      expect(fullDateHe, isNotEmpty);
    });
  });
}
