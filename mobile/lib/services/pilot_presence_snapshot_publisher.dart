import 'dart:convert';

import '../models/commitment.dart';
import '../models/pilot_loop_analytics.dart';
import '../models/pilot_presence.dart';
import '../config/app_config.dart';
import 'contracts/pilot_loop_analytics_service.dart';
import 'contracts/pilot_presence_store.dart';
import 'watch_snapshot_bridge.dart';

class PilotPresenceSnapshotPublisher {
  final PilotPresenceStore store;
  final PilotLoopAnalyticsService? analyticsService;
  final PilotPresenceFeatureFlags flags;
  final DateTime Function() now;
  final Duration snapshotTtl;

  /// Whether the user has allowed the widget to name commitments.
  ///
  /// Off by default: a Home Screen widget is read by whoever is standing
  /// nearby, so naming a commitment is the user's decision to make, not ours.
  /// On, the widget can finally answer what deserves attention now instead of
  /// listing rows that all read "Private commitment".
  final bool widgetShowsTitles;

  /// How the snapshot reaches a paired Apple Watch, if there is one.
  final WatchSnapshotBridge? watchBridge;

  const PilotPresenceSnapshotPublisher({
    required this.store,
    required this.now,
    this.analyticsService,
    this.flags = const PilotPresenceFeatureFlags(
      widget: false,
      voice: false,
      awareness: false,
      watch: false,
      imports: false,
    ),
    this.snapshotTtl = const Duration(minutes: 30),
    this.widgetShowsTitles = false,
    this.watchBridge,
  });

  Future<void> publishWidgetSnapshot(List<Commitment> commitments) async {
    final generatedAt = now().toUtc();
    final visibleCommitments = _prioritizedWidgetCommitments(commitments);
    final snapshot = CommitmentSnapshot.fromCommitments(
      commitments: visibleCommitments,
      generatedAt: generatedAt,
      expiresAt: generatedAt.add(snapshotTtl),
      surface: PilotPresenceSurface.widget,
      titlePrivacy: widgetShowsTitles
          // Named for the widget alone. Every other surface -- the watch above
          // all -- makes its own decision rather than inheriting this one.
          ? SnapshotTitlePrivacy(
              mode: SnapshotTitlePrivacyMode.explicitlyAllowed,
              allowedSurfaceIds: {PilotPresenceSurface.widget.surfaceId},
            )
          : const SnapshotTitlePrivacy(
              mode: SnapshotTitlePrivacyMode.neverIncludeTitles,
            ),
    );

    await store.publishSnapshot(snapshot);
    await _publishToWatch(visibleCommitments, generatedAt);
    try {
      await analyticsService?.record(
        // Publishing the snapshot is all that happened here. Calling it an
        // impression would count a write as something a person saw.
        PilotLoopAnalyticsEvent.widgetSnapshotPublished(
          surface: 'homeWidget',
          snapshotState: snapshot.displayState(generatedAt).name,
          flags: flags,
        ),
      );
    } catch (_) {}
  }

  Future<void> clearWidgetSnapshot() async {
    await store.clearSnapshot();
    await _clearWatch();
  }

  /// Send the watch its own snapshot for its own surface.
  ///
  /// Built separately from the widget's rather than forwarded, because the
  /// surfaces answer the title question independently: a wrist is read over
  /// your shoulder, so allowing titles on the Home Screen says nothing about
  /// allowing them here.
  Future<void> _publishToWatch(
    List<Commitment> commitments,
    DateTime generatedAt,
  ) async {
    final bridge = watchBridge;
    if (bridge == null) return;
    if (!flags.watch) {
      await _clearWatch();
      return;
    }
    if (!await bridge.isSupported()) return;

    final snapshot = CommitmentSnapshot.fromCommitments(
      commitments: commitments,
      generatedAt: generatedAt,
      expiresAt: generatedAt.add(snapshotTtl),
      surface: PilotPresenceSurface.watch,
      titlePrivacy: const SnapshotTitlePrivacy(
        mode: SnapshotTitlePrivacyMode.neverIncludeTitles,
      ),
    );

    try {
      await bridge.publishSnapshot(jsonEncode(snapshot.toJson()));
    } catch (_) {
      // No watch, or one that refused the context. The phone's own presence is
      // unaffected, so this must not fail the publish.
    }
  }

  Future<void> _clearWatch() async {
    final bridge = watchBridge;
    if (bridge == null) return;
    if (!await bridge.isSupported()) return;
    try {
      await bridge.clearSnapshot();
    } catch (_) {}
  }

  List<Commitment> _prioritizedWidgetCommitments(List<Commitment> commitments) {
    final active = commitments
        .where((commitment) => !commitment.status.isCompleted)
        .toList(growable: false);
    final sorted = [...active]..sort(_compareCommitmentsForWidget);
    return sorted.take(3).toList(growable: false);
  }

  int _compareCommitmentsForWidget(Commitment a, Commitment b) {
    final priority = _priorityRank(
      a.priority,
    ).compareTo(_priorityRank(b.priority));
    if (priority != 0) return priority;

    final date = _dateRank(a).compareTo(_dateRank(b));
    if (date != 0) return date;

    return a.title.compareTo(b.title);
  }

  int _priorityRank(CommitmentPriority priority) {
    return switch (priority) {
      CommitmentPriority.must => 0,
      CommitmentPriority.should => 1,
      CommitmentPriority.nice => 2,
    };
  }

  int _dateRank(Commitment commitment) {
    return commitment.scheduledDate?.millisecondsSinceEpoch ?? 1 << 62;
  }
}
