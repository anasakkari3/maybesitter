import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_loop_analytics.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/pilot_presence_store.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_pilot_loop_analytics_service.dart';
import 'package:maybesitter_mobile/services/pilot_presence_snapshot_publisher.dart';
import 'package:maybesitter_mobile/services/shared_preferences_pilot_presence_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Pilot presence contracts', () {
    test('CommitmentSnapshot serializes stable native-facing payload', () {
      final generatedAt = DateTime.utc(2026, 8, 19, 12);
      final expiresAt = generatedAt.add(const Duration(minutes: 30));
      final commitment = Commitment(
        id: 'comm-1',
        title: 'Pay sitter invoice',
        scheduledDate: DateTime.utc(2026, 8, 20, 16, 30),
        startTime: '16:30',
        endTime: '17:00',
        location: 'Community center',
        priority: CommitmentPriority.must,
      );

      final snapshot = CommitmentSnapshot.fromCommitments(
        commitments: [commitment],
        generatedAt: generatedAt,
        expiresAt: expiresAt,
        surface: PilotPresenceSurface.widget,
        titlePrivacy: const SnapshotTitlePrivacy(
          mode: SnapshotTitlePrivacyMode.explicitlyAllowed,
          allowedSurfaceIds: {'widget'},
        ),
      );

      final restored = CommitmentSnapshot.fromJson(snapshot.toJson());

      expect(restored.schemaVersion, CommitmentSnapshot.currentSchemaVersion);
      expect(restored.surface, PilotPresenceSurface.widget);
      expect(restored.generatedAt, generatedAt);
      expect(restored.expiresAt, expiresAt);
      expect(restored.isStale(DateTime.utc(2026, 8, 19, 12, 29)), isFalse);
      expect(restored.items, hasLength(1));
      expect(restored.items.single.id, 'comm-1');
      expect(restored.items.single.title, 'Pay sitter invoice');
      expect(restored.items.single.titleRedacted, isFalse);
      expect(restored.items.single.priority, CommitmentPriority.must);
      expect(restored.items.single.sourceCanMutateCanonicalState, isFalse);
    });

    test('redacts titles unless a surface is explicitly allowed', () {
      const commitment = Commitment(
        id: 'private-1',
        title: 'Talk to school counselor',
        priority: CommitmentPriority.should,
      );

      final snapshot = CommitmentSnapshot.fromCommitments(
        commitments: const [commitment],
        generatedAt: DateTime.utc(2026, 8, 19, 12),
        expiresAt: DateTime.utc(2026, 8, 19, 13),
        surface: PilotPresenceSurface.watch,
        titlePrivacy: const SnapshotTitlePrivacy(
          mode: SnapshotTitlePrivacyMode.allowedSurfacesOnly,
          allowedSurfaceIds: {'widget'},
        ),
      );

      final item = snapshot.items.single;
      expect(item.title, CommitmentSnapshotItem.redactedTitle);
      expect(item.titleRedacted, isTrue);
      expect(item.redactionReason, SnapshotRedactionReason.surfaceNotAllowed);
      expect(snapshot.toJson()['items'], [
        containsPair('title', CommitmentSnapshotItem.redactedTitle),
      ]);
    });

    test('manual snapshots cannot leak titles when policy forbids them', () {
      final snapshot = CommitmentSnapshot(
        schemaVersion: CommitmentSnapshot.currentSchemaVersion,
        generatedAt: DateTime.utc(2026, 8, 19, 12),
        expiresAt: DateTime.utc(2026, 8, 19, 13),
        surface: PilotPresenceSurface.notification,
        titlePrivacy: const SnapshotTitlePrivacy(
          mode: SnapshotTitlePrivacyMode.neverIncludeTitles,
        ),
        items: const [
          CommitmentSnapshotItem(
            id: 'leak-1',
            title: 'Call therapist',
            titleRedacted: false,
            redactionReason: SnapshotRedactionReason.none,
            priority: CommitmentPriority.must,
          ),
        ],
      );

      final json = snapshot.toJson();
      final restored = CommitmentSnapshot.fromJson(json);

      expect(json['items'], [
        containsPair('title', CommitmentSnapshotItem.redactedTitle),
      ]);
      expect(restored.items.single.title, CommitmentSnapshotItem.redactedTitle);
      expect(restored.items.single.titleRedacted, isTrue);
      expect(
        restored.items.single.redactionReason,
        SnapshotRedactionReason.titlesDisabled,
      );
      expect(
        restored
            .safeItemsForDisplay(DateTime.utc(2026, 8, 19, 12, 5))
            .single
            .title,
        CommitmentSnapshotItem.redactedTitle,
      );
    });

    test(
      'stale snapshots are readable but marked unsafe for native display',
      () {
        final snapshot = CommitmentSnapshot(
          schemaVersion: CommitmentSnapshot.currentSchemaVersion,
          generatedAt: DateTime.utc(2026, 8, 19, 8),
          expiresAt: DateTime.utc(2026, 8, 19, 9),
          surface: PilotPresenceSurface.notification,
          titlePrivacy: const SnapshotTitlePrivacy(
            mode: SnapshotTitlePrivacyMode.neverIncludeTitles,
          ),
          items: const [],
        );

        final restored = CommitmentSnapshot.fromJson(snapshot.toJson());

        expect(restored.isStale(DateTime.utc(2026, 8, 19, 9, 1)), isTrue);
        expect(
          restored.displayState(DateTime.utc(2026, 8, 19, 9, 1)),
          CommitmentSnapshotDisplayState.stale,
        );
        expect(
          restored.safeItemsForDisplay(DateTime.utc(2026, 8, 19, 9, 1)),
          isEmpty,
        );
      },
    );

    test('ReminderPolicy and UserRoutineProfile round-trip safely', () {
      final policy = ReminderPolicy(
        schemaVersion: ReminderPolicy.currentSchemaVersion,
        maxIntensity: ReminderIntensity.followUp,
        softAwarenessLeadTime: const Duration(hours: 1),
        followUpLeadTime: const Duration(minutes: 30),
        strongReminderLeadTime: const Duration(minutes: 10),
        strongRemindersRequireExplicitOptIn: true,
        quietHoursRespectMode: QuietHoursRespectMode.deferUnlessMustAndAllowed,
      );

      final profile = UserRoutineProfile(
        schemaVersion: UserRoutineProfile.currentSchemaVersion,
        updatedAt: DateTime.utc(2026, 8, 19, 10),
        timezone: 'Asia/Jerusalem',
        sleepWindow: const RoutineTimeWindow(start: '23:00', end: '07:00'),
        focusWindows: const [
          RoutineTimeWindow(start: '09:00', end: '17:00', label: 'work'),
        ],
        fixedCommitmentWindows: const [
          RoutineTimeWindow(start: '18:00', end: '19:00', label: 'school run'),
        ],
        preferredReminderIntensity: ReminderIntensity.softAwareness,
        quietHours: const RoutineTimeWindow(start: '22:00', end: '07:30'),
        surveySkipped: false,
      );

      expect(
        ReminderPolicy.fromJson(policy.toJson()).toJson(),
        policy.toJson(),
      );
      expect(
        UserRoutineProfile.fromJson(profile.toJson()).toJson(),
        profile.toJson(),
      );
    });

    test('AppConfig exposes independent pilot presence kill switches', () {
      const config = AppConfig(
        enablePilotWidget: true,
        enablePilotVoice: false,
        enablePilotAwareness: true,
        enablePilotWatch: false,
        enablePilotImports: true,
      );

      expect(config.pilotPresenceFlags.widget, isTrue);
      expect(config.pilotPresenceFlags.voice, isFalse);
      expect(config.pilotPresenceFlags.awareness, isTrue);
      expect(config.pilotPresenceFlags.watch, isFalse);
      expect(config.pilotPresenceFlags.imports, isTrue);
      expect(config.pilotPresenceFlags.toJson(), {
        'widget': true,
        'voice': false,
        'awareness': true,
        'watch': false,
        'imports': true,
      });
    });

    test('AppConfig kill switches override enabled pilot flags', () {
      const config = AppConfig(
        enablePilotWidget: true,
        enablePilotVoice: true,
        enablePilotAwareness: true,
        enablePilotWatch: true,
        enablePilotImports: true,
        killPilotWidget: true,
        killPilotVoice: true,
        killPilotAwareness: true,
        killPilotWatch: true,
        killPilotImports: true,
      );

      expect(config.pilotPresenceFlags.toJson(), {
        'widget': false,
        'voice': false,
        'awareness': false,
        'watch': false,
        'imports': false,
      });
    });
  });

  group('SharedPreferencesPilotPresenceStore', () {
    test(
      'publishes and reads only the native snapshot bridge payload',
      () async {
        SharedPreferences.setMockInitialValues({});
        final bridge = _FakePilotPresenceSharedStoreBridge();
        final store = SharedPreferencesPilotPresenceStore(
          sharedStoreBridge: bridge,
        );
        final snapshot = CommitmentSnapshot(
          schemaVersion: CommitmentSnapshot.currentSchemaVersion,
          generatedAt: DateTime.utc(2026, 8, 19, 12),
          expiresAt: DateTime.utc(2026, 8, 19, 12, 20),
          surface: PilotPresenceSurface.widget,
          titlePrivacy: const SnapshotTitlePrivacy(
            mode: SnapshotTitlePrivacyMode.neverIncludeTitles,
          ),
          items: const [
            CommitmentSnapshotItem(
              id: 'comm-1',
              title: CommitmentSnapshotItem.redactedTitle,
              titleRedacted: true,
              redactionReason: SnapshotRedactionReason.titlesDisabled,
              priority: CommitmentPriority.must,
            ),
          ],
        );

        await store.publishSnapshot(snapshot);
        final prefs = await SharedPreferences.getInstance();
        final raw = prefs.getString(PilotPresenceStoreKeys.snapshotV1);
        expect(raw, isNotNull);
        expect(bridge.writes, hasLength(1));
        expect(
          bridge.writes.single.suiteName,
          PilotPresenceStoreKeys.appGroupIdentifier,
        );
        expect(bridge.writes.single.key, PilotPresenceStoreKeys.snapshotV1);
        expect(bridge.writes.single.value, raw);

        final restored = await store.readSnapshot();
        expect(restored?.toJson(), snapshot.toJson());
      },
    );

    test(
      'returns null instead of throwing on corrupt shared payload',
      () async {
        SharedPreferences.setMockInitialValues({
          PilotPresenceStoreKeys.snapshotV1: 'not-json',
        });
        final store = SharedPreferencesPilotPresenceStore();

        final snapshot = await store.readSnapshot();

        expect(snapshot, isNull);
      },
    );

    test('bridge contract exposes no canonical mutation commands', () {
      expect(
        PilotPresenceStore.allowedNativeOperations,
        equals(const {'readSnapshot'}),
      );
      expect(PilotPresenceStoreKeys.appGroupIdentifier, isNotEmpty);
    });
  });

  group('PilotPresenceSnapshotPublisher', () {
    test(
      'publishes a bounded widget snapshot from active commitments',
      () async {
        final store = _FakePilotPresenceStore();
        final publisher = PilotPresenceSnapshotPublisher(
          store: store,
          now: () => DateTime.utc(2026, 8, 19, 12),
        );

        await publisher.publishWidgetSnapshot([
          Commitment(
            id: 'done',
            title: 'Already done',
            status: CommitmentStatus.completed,
            priority: CommitmentPriority.must,
            scheduledDate: DateTime.utc(2026, 8, 19, 8),
          ),
          Commitment(
            id: 'nice',
            title: 'Optional errand',
            priority: CommitmentPriority.nice,
            scheduledDate: DateTime.utc(2026, 8, 19, 9),
          ),
          Commitment(
            id: 'must',
            title: 'Private doctor appointment',
            priority: CommitmentPriority.must,
            scheduledDate: DateTime.utc(2026, 8, 19, 14),
          ),
        ]);

        final snapshot = store.snapshot;
        expect(snapshot, isNotNull);
        expect(snapshot!.surface, PilotPresenceSurface.widget);
        expect(snapshot.generatedAt, DateTime.utc(2026, 8, 19, 12));
        expect(snapshot.expiresAt, DateTime.utc(2026, 8, 19, 12, 30));
        expect(snapshot.items.map((item) => item.id), ['must', 'nice']);
      },
    );

    test(
      'redacts widget titles until an explicit title surface exists',
      () async {
        final store = _FakePilotPresenceStore();
        final publisher = PilotPresenceSnapshotPublisher(
          store: store,
          now: () => DateTime.utc(2026, 8, 19, 12),
        );

        await publisher.publishWidgetSnapshot([
          const Commitment(
            id: 'private',
            title: 'Call therapist',
            priority: CommitmentPriority.must,
          ),
        ]);

        final item = store.snapshot!.items.single;
        expect(item.title, CommitmentSnapshotItem.redactedTitle);
        expect(item.titleRedacted, isTrue);
        expect(item.redactionReason, SnapshotRedactionReason.titlesDisabled);
      },
    );

    test('records a content-free widget impression when publishing', () async {
      final store = _FakePilotPresenceStore();
      final analytics = InMemoryPilotLoopAnalyticsService();
      final publisher = PilotPresenceSnapshotPublisher(
        store: store,
        analyticsService: analytics,
        flags: const PilotPresenceFeatureFlags(
          widget: true,
          voice: true,
          awareness: false,
          watch: false,
          imports: false,
        ),
        now: () => DateTime.utc(2026, 8, 19, 12),
      );

      await publisher.publishWidgetSnapshot([
        const Commitment(
          id: 'private',
          title: 'Call therapist',
          priority: CommitmentPriority.must,
        ),
      ]);

      expect(
        analytics.events.single.name,
        PilotLoopAnalyticsEventName.widgetImpression,
      );
      expect(analytics.events.single.properties['widgetState'], 'populated');
      expect(analytics.events.single.properties, isNot(contains('title')));
    });
  });
}

class _FakePilotPresenceSharedStoreBridge
    implements PilotPresenceSharedStoreBridge {
  final List<_BridgeWrite> writes = [];
  final Map<String, String> _values = {};

  @override
  Future<String?> readString({
    required String suiteName,
    required String key,
  }) async {
    return _values['$suiteName:$key'];
  }

  @override
  Future<bool> writeString({
    required String suiteName,
    required String key,
    required String value,
  }) async {
    writes.add(_BridgeWrite(suiteName: suiteName, key: key, value: value));
    _values['$suiteName:$key'] = value;
    return true;
  }

  @override
  Future<void> removeString({
    required String suiteName,
    required String key,
  }) async {
    _values.remove('$suiteName:$key');
  }
}

class _BridgeWrite {
  final String suiteName;
  final String key;
  final String value;

  const _BridgeWrite({
    required this.suiteName,
    required this.key,
    required this.value,
  });
}

class _FakePilotPresenceStore implements PilotPresenceStore {
  CommitmentSnapshot? snapshot;
  var clearCalls = 0;

  @override
  Future<void> clearSnapshot() async {
    clearCalls += 1;
    snapshot = null;
  }

  @override
  Future<void> publishSnapshot(CommitmentSnapshot snapshot) async {
    this.snapshot = snapshot;
  }

  @override
  Future<CommitmentSnapshot?> readSnapshot() async => snapshot;
}
