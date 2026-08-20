/// The watch is fed the same snapshot the widget is.
///
/// App Groups do not reach an Apple Watch, so the snapshot travels over
/// WatchConnectivity instead. What travels must be the identical payload: two
/// surfaces disagreeing about what is important is exactly the failure this
/// contract exists to prevent.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/pilot_presence_snapshot_publisher.dart';
import 'package:maybesitter_mobile/services/shared_preferences_pilot_presence_store.dart';
import 'package:maybesitter_mobile/services/watch_snapshot_bridge.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _RecordingWatchBridge implements WatchSnapshotBridge {
  final List<String?> published = [];
  bool supported = true;
  bool reachable = true;

  @override
  Future<bool> isSupported() async => supported;

  @override
  Future<bool> publishSnapshot(String json) async {
    published.add(json);
    return reachable;
  }

  @override
  Future<bool> clearSnapshot() async {
    published.add(null);
    return reachable;
  }

  @override
  Future<Map<String, Object?>> diagnostics() async => {
    'supported': supported,
    'isWatchAppInstalled': reachable,
  };
}

final _must = Commitment(
  id: 'c1',
  title: 'Exam',
  scheduledDate: DateTime(2026, 8, 20),
  startTime: '10:00',
  priority: CommitmentPriority.must,
);

PilotPresenceSnapshotPublisher _publisher(
  _RecordingWatchBridge bridge, {
  bool watchFlag = true,
  bool widgetShowsTitles = false,
}) => PilotPresenceSnapshotPublisher(
  store: SharedPreferencesPilotPresenceStore(),
  now: () => DateTime.utc(2026, 8, 20, 8),
  watchBridge: bridge,
  widgetShowsTitles: widgetShowsTitles,
  flags: PilotPresenceFeatureFlags(
    widget: true,
    voice: false,
    awareness: false,
    watch: watchFlag,
    imports: false,
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the watch gets the phone\'s snapshot', () {
    test('publishing a snapshot forwards it to the watch', () async {
      final bridge = _RecordingWatchBridge();

      await _publisher(bridge).publishWidgetSnapshot([_must]);

      expect(bridge.published, hasLength(1));
      final sent = jsonDecode(bridge.published.single!) as Map<String, dynamic>;
      expect(sent['contract'], 'commitmentSnapshot');
      expect((sent['items'] as List).single['id'], 'c1');
    });

    test('the watch is sent its own surface, not the widget\'s', () async {
      final bridge = _RecordingWatchBridge();

      await _publisher(bridge).publishWidgetSnapshot([_must]);

      final sent = jsonDecode(bridge.published.single!) as Map<String, dynamic>;
      expect(sent['surface'], 'watch');
    });

    test('allowing titles on the widget does not name them on the wrist', () async {
      final bridge = _RecordingWatchBridge();

      await _publisher(bridge, widgetShowsTitles: true)
          .publishWidgetSnapshot([_must]);

      final sent = jsonDecode(bridge.published.single!) as Map<String, dynamic>;
      final item = (sent['items'] as List).single as Map<String, dynamic>;
      expect(
        item['titleRedacted'],
        isTrue,
        reason: 'a wrist is read over your shoulder; it is a separate decision',
      );
    });
  });

  group('the watch kill switch', () {
    test('a disabled watch is cleared, not left showing stale state', () async {
      final bridge = _RecordingWatchBridge();

      await _publisher(bridge, watchFlag: false).publishWidgetSnapshot([_must]);

      expect(bridge.published, [null]);
    });
  });

  group('an absent watch is not a failure', () {
    test('publishing still succeeds when nothing is paired', () async {
      final bridge = _RecordingWatchBridge()..reachable = false;

      await _publisher(bridge).publishWidgetSnapshot([_must]);

      // The widget snapshot is the phone's own surface and must land either way.
      final store = SharedPreferencesPilotPresenceStore();
      expect(await store.readSnapshot(), isNotNull);
    });

    test('an unsupported platform is never asked to publish', () async {
      final bridge = _RecordingWatchBridge()..supported = false;

      await _publisher(bridge).publishWidgetSnapshot([_must]);

      expect(bridge.published, isEmpty);
    });
  });
}
