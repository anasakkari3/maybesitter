import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:maybesitter_mobile/core/utilities/date_formatter.dart';
import 'package:maybesitter_mobile/core/utilities/l10n_extensions.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/app_settings.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

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

    test('Priority localization across English, Arabic, and Hebrew', () {
      expect(CommitmentPriority.must.localizedName(l10nEn), equals('MUST'));
      expect(CommitmentPriority.must.localizedName(l10nAr), equals('ضروري'));
      expect(CommitmentPriority.must.localizedName(l10nHe), equals('חובה'));

      expect(CommitmentPriority.should.localizedName(l10nEn), equals('SHOULD'));
      expect(CommitmentPriority.should.localizedName(l10nAr), equals('مستحسن'));
      expect(CommitmentPriority.should.localizedName(l10nHe), equals('מומלץ'));

      expect(CommitmentPriority.nice.localizedName(l10nEn), equals('NICE'));
      expect(CommitmentPriority.nice.localizedName(l10nAr), equals('اختياري'));
      expect(
        CommitmentPriority.nice.localizedName(l10nHe),
        equals('אופציונלי'),
      );
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
          equals('בהמתנה'),
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
          equals('הושלמה'),
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
          equals('נדחתה'),
        );
      },
    );

    test(
      'SharedPreferences persistence reconstruction & state restoration',
      () async {
        // 1. Initialize SharedPreferences with no locale
        SharedPreferences.setMockInitialValues({});

        var notifier = AppSettingsNotifier();
        await Future<void>.delayed(Duration.zero);
        expect(notifier.state.localeOption, equals(AppLocaleOption.system));

        // 2. Select Hebrew & persist
        await notifier.updateLocale(AppLocaleOption.hebrew);
        var prefs = await SharedPreferences.getInstance();
        expect(prefs.getString('locale_option'), equals('he'));

        // 3. Dispose state & create fresh state from reloaded SharedPreferences
        notifier.dispose();
        var reloadedNotifier = AppSettingsNotifier();
        await Future<void>.delayed(Duration.zero);
        expect(
          reloadedNotifier.state.localeOption,
          equals(AppLocaleOption.hebrew),
        );

        // 4. Test Arabic restoration
        await reloadedNotifier.updateLocale(AppLocaleOption.arabic);
        reloadedNotifier.dispose();
        reloadedNotifier = AppSettingsNotifier();
        await Future<void>.delayed(Duration.zero);
        expect(
          reloadedNotifier.state.localeOption,
          equals(AppLocaleOption.arabic),
        );

        // 5. Test System default restoration
        await reloadedNotifier.updateLocale(AppLocaleOption.system);
        reloadedNotifier.dispose();
        reloadedNotifier = AppSettingsNotifier();
        await Future<void>.delayed(Duration.zero);
        expect(
          reloadedNotifier.state.localeOption,
          equals(AppLocaleOption.system),
        );

        // 6. Test invalid stored value falls back safely to system
        SharedPreferences.setMockInitialValues({
          'locale_option': 'invalid_lang',
        });
        reloadedNotifier.dispose();
        reloadedNotifier = AppSettingsNotifier();
        await Future<void>.delayed(Duration.zero);
        expect(
          reloadedNotifier.state.localeOption,
          equals(AppLocaleOption.system),
        );
      },
    );

    test('Fixed Reference DateTime formatting (2026-07-28T15:30:00)', () {
      final date = DateTime(2026, 7, 28, 15, 30, 0);

      final fullDateEn = DateFormatter.formatFullDate(date, locale: 'en');
      final fullDateAr = DateFormatter.formatFullDate(date, locale: 'ar');
      final fullDateHe = DateFormatter.formatFullDate(date, locale: 'he');

      expect(fullDateEn, contains('July 28, 2026'));
      expect(fullDateAr, contains('2026'));
      expect(fullDateHe, contains('2026'));

      expect(
        DateFormatter.stripIsolates(DateFormatter.formatTime('15:30')),
        equals('15:30'),
      );
      expect(l10nEn.tomorrowGroupHeader, equals('Tomorrow'));
      expect(l10nAr.tomorrowGroupHeader, equals('غدًا'));
      expect(l10nHe.tomorrowGroupHeader, equals('מחר'));
    });

    test(
      'Arabic ICU plural branches for 0, 1, 2, 3, 11, and 100 commitments',
      () {
        expect(
          l10nAr.commitmentsCountToday(0),
          equals('لا توجد التزامات نشطة اليوم'),
        );
        expect(
          l10nAr.commitmentsCountToday(1),
          equals('التزام واحد متبقٍ اليوم'),
        );
        expect(
          l10nAr.commitmentsCountToday(2),
          equals('التزامان متبقيان اليوم'),
        );
        expect(
          l10nAr.commitmentsCountToday(3),
          equals('3 التزامات متبقية اليوم'),
        );
        expect(
          l10nAr.commitmentsCountToday(11),
          equals('11 التزامًا متبقيًا اليوم'),
        );
        expect(
          l10nAr.commitmentsCountToday(100),
          equals('100 التزام متبقٍ اليوم'),
        );

        expect(l10nAr.confirmCommitmentsAction(1), equals('تأكيد التزام واحد'));
        expect(l10nAr.confirmCommitmentsAction(2), equals('تأكيد التزامين'));
        expect(l10nAr.confirmCommitmentsAction(3), equals('تأكيد 3 التزامات'));
        expect(
          l10nAr.confirmCommitmentsAction(11),
          equals('تأكيد 11 التزامًا'),
        );
        expect(
          l10nAr.confirmCommitmentsAction(100),
          equals('تأكيد 100 التزام'),
        );
      },
    );

    test('Hebrew plurals for 0, 1, 2, 3, 11, and 100 commitments', () {
      expect(
        l10nHe.commitmentsCountToday(0),
        equals('אין התחייבויות פעילות היום'),
      );
      expect(
        l10nHe.commitmentsCountToday(1),
        equals('התחייבות אחת נותרה להיום'),
      );
      expect(
        l10nHe.commitmentsCountToday(2),
        equals('שתי התחייבויות נותרו להיום'),
      );
      expect(
        l10nHe.commitmentsCountToday(3),
        equals('3 התחייבויות נותרו להיום'),
      );
      expect(
        l10nHe.commitmentsCountToday(11),
        equals('11 התחייבויות נותרו להיום'),
      );
      expect(
        l10nHe.commitmentsCountToday(100),
        equals('100 התחייבויות נותרו להיום'),
      );

      expect(l10nHe.confirmCommitmentsAction(1), equals('אישור התחייבות אחת'));
      expect(
        l10nHe.confirmCommitmentsAction(2),
        equals('אישור שתי התחייבויות'),
      );
      expect(l10nHe.confirmCommitmentsAction(3), equals('אישור 3 התחייבויות'));
      expect(
        l10nHe.confirmCommitmentsAction(11),
        equals('אישור 11 התחייבויות'),
      );
      expect(
        l10nHe.confirmCommitmentsAction(100),
        equals('אישור 100 התחייבויות'),
      );
    });
  });
}
