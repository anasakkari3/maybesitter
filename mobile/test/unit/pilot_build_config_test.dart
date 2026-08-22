import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The pilot build's dart-defines, checked in so they cannot be forgotten.
///
/// Omitting `REQUIRE_PILOT_ACCESS_GATE` ships a pilot build with no access
/// control at all, and nothing about the running app looks wrong — which is
/// exactly why a person typing the command from memory is not the control.
void main() {
  group('pilot build configuration', () {
    late Map<String, dynamic> config;

    setUp(() {
      final file = File('config/pilot.json');
      expect(
        file.existsSync(),
        isTrue,
        reason: 'config/pilot.json is the pilot build definition; it must exist',
      );
      config = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    });

    test('the access gate is on', () {
      expect(
        config['REQUIRE_PILOT_ACCESS_GATE'],
        'true',
        reason: 'a pilot build without this opens to anyone who installs it',
      );
    });

    test('commitment editing is enabled', () {
      expect(
        config['ENABLE_SAFE_COMMITMENT_PATCH'],
        'true',
        reason: 'without this a participant cannot edit a title or a time',
      );
    });

    test('every value is a string, as --dart-define-from-file requires', () {
      for (final entry in config.entries) {
        expect(
          entry.value,
          isA<String>(),
          reason: '${entry.key} must be a string; Flutter rejects other types',
        );
      }
    });

    test('no backend URL is baked in', () {
      // API_BASE_URL is environment-specific and belongs on the build command.
      // Checking one in would point every pilot build at whatever host the
      // file happened to name.
      expect(config.containsKey('API_BASE_URL'), isFalse);
    });
  });
}
