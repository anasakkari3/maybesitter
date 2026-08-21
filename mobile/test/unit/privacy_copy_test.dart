/// The privacy copy has to match what the app actually does.
///
/// It promised "complete privacy" while claiming nothing about where the
/// analysis runs. Two things in this repository contradict that promise:
///
///   * `ApiCaptureService.capture` posts the raw sentence to
///     `/api/mobile/capture` (lib/services/api/api_capture_service.dart), so
///     in the backend configuration the text does leave the device.
///   * Nothing anywhere constructs a remote model client, so no escalation
///     happens yet -- and nothing can guarantee a remote provider deletes
///     anything.
///
/// The copy therefore states where analysis happens and disclaims the
/// deletion guarantee the app cannot make, rather than promising one.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _locales = ['en', 'ar', 'he'];

Map<String, dynamic> _arb(String locale) =>
    jsonDecode(File('lib/l10n/app_$locale.arb').readAsStringSync())
        as Map<String, dynamic>;

void main() {
  test('the Arabic note no longer claims complete privacy', () {
    expect(_arb('ar')['privacyNote'], isNot(contains('تامة')));
  });

  test('every locale explains when something is sent', () {
    for (final locale in _locales) {
      expect(
        _arb(locale)['privacyEscalationNote'],
        isNotNull,
        reason: '$locale has no escalation note',
      );
    }
  });

  test('the note says where the analysis happens, device included', () {
    expect(_arb('ar')['privacyNote'], contains('جهازك'));
    expect(_arb('en')['privacyNote'], contains('device'));
    expect(_arb('he')['privacyNote'], contains('מכשיר'));
  });

  test('no locale promises a deletion the app cannot perform', () {
    // No remote provider client exists in this repository, so "deleted
    // afterwards" would be a promise about a system that has not been built.
    // The copy has to disclaim it instead.
    const promises = {
      'ar': 'وتُحذف بعدها',
      'en': 'deleted afterwards',
      'he': 'ונמחקים לאחר מכן',
    };
    const disclaimers = {'ar': 'لا يمكننا', 'en': 'cannot', 'he': 'איננו'};

    for (final locale in _locales) {
      final note = _arb(locale)['privacyEscalationNote'] as String;
      expect(
        note,
        isNot(contains(promises[locale])),
        reason: '$locale promises deletion nothing in the code guarantees',
      );
      expect(
        note,
        contains(disclaimers[locale]),
        reason: '$locale does not say the guarantee is missing',
      );
    }
  });

  test('the escalation note is true today: nothing goes to an outside model', () {
    expect(_arb('ar')['privacyEscalationNote'], contains('خارجي'));
    expect(_arb('en')['privacyEscalationNote'], contains('outside model'));
    expect(_arb('he')['privacyEscalationNote'], contains('חיצוני'));
  });

  test('both privacy keys carry real copy in all three locales', () {
    for (final locale in _locales) {
      for (final key in ['privacyNote', 'privacyEscalationNote']) {
        final value = _arb(locale)[key];
        expect(value, isA<String>(), reason: '$locale/$key is not a string');
        expect(
          (value as String).trim(),
          isNotEmpty,
          reason: '$locale/$key is blank',
        );
      }
    }
  });

  test('the generated localisations match the ARB sources', () {
    // gen-l10n output is committed, so a hand-edited ARB with a stale
    // generated file would ship the old promise to the user.
    for (final locale in _locales) {
      final generated = File(
        'lib/l10n/generated/app_localizations_$locale.dart',
      ).readAsStringSync();

      for (final key in ['privacyNote', 'privacyEscalationNote']) {
        expect(
          generated,
          contains('get $key'),
          reason: '$locale generated file has no $key -- run flutter gen-l10n',
        );
        expect(
          generated,
          contains(_escapeForDart(_arb(locale)[key] as String)),
          reason: '$locale generated $key is stale -- run flutter gen-l10n',
        );
      }
    }
  });
}

/// gen-l10n emits single-quoted Dart strings, so an apostrophe in the copy
/// comes back escaped.
String _escapeForDart(String value) => value.replaceAll("'", r"\'");
