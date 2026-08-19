import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_loop_analytics.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_pilot_loop_analytics_service.dart';
import 'package:maybesitter_mobile/services/pilot_presence_snapshot_publisher.dart';
import 'package:maybesitter_mobile/services/shared_preferences_pilot_presence_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _flags = PilotPresenceFeatureFlags(
  widget: true,
  voice: false,
  awareness: false,
  watch: false,
  imports: false,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  PilotPresenceSnapshotPublisher publisher(
    InMemoryPilotLoopAnalyticsService analytics,
  ) => PilotPresenceSnapshotPublisher(
    store: SharedPreferencesPilotPresenceStore(),
    now: () => DateTime.utc(2026, 8, 19, 8),
    analyticsService: analytics,
    flags: _flags,
  );

  group('publishing a snapshot is not the user seeing it', () {
    test('publishing records a snapshot event, never an impression', () async {
      final analytics = InMemoryPilotLoopAnalyticsService();

      await publisher(analytics).publishWidgetSnapshot([
        Commitment(
          id: 'c1',
          title: 'Exam',
          scheduledDate: DateTime(2026, 8, 19),
          priority: CommitmentPriority.must,
        ),
      ]);

      final names = analytics.events.map((event) => event.name);
      expect(names, contains(PilotLoopAnalyticsEventName.widgetSnapshotPublished));
      expect(
        names,
        isNot(contains(PilotLoopAnalyticsEventName.widgetImpression)),
        reason: 'the app cannot know the widget was looked at',
      );
    });

    test('the wire name says published, not impression', () {
      expect(
        PilotLoopAnalyticsEventName.widgetSnapshotPublished.wireName,
        'widget_snapshot_published',
      );
    });

    test('a snapshot event does not claim a widget family it never saw', () async {
      final analytics = InMemoryPilotLoopAnalyticsService();

      await publisher(analytics).publishWidgetSnapshot([]);

      final event = analytics.events.firstWhere(
        (event) =>
            event.name == PilotLoopAnalyticsEventName.widgetSnapshotPublished,
      );
      expect(event.properties.containsKey('widgetFamily'), isFalse);
    });
  });

  group('impressions come from the widget itself', () {
    test('an impression reported by the widget names its family', () {
      final event = PilotLoopAnalyticsEvent.widgetImpression(
        surface: 'homeWidget',
        widgetFamily: 'systemSmall',
        widgetState: 'populated',
        flags: _flags,
      );

      expect(event.properties['widgetFamily'], 'systemSmall');
    });
  });
}
