/// Whether the widget may name a commitment is the user's choice.
///
/// The publisher used to hardcode neverIncludeTitles, so every row on the Home
/// Screen read "Private commitment" and the widget could not answer the one
/// question it exists for. The privacy model already supported allowing a
/// surface; nothing ever asked for it.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
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

final _commitment = Commitment(
  id: 'c1',
  title: 'Renew the insurance',
  scheduledDate: DateTime(2026, 8, 20),
  priority: CommitmentPriority.must,
);

Future<CommitmentSnapshot?> _publish({required bool showTitles}) async {
  final store = SharedPreferencesPilotPresenceStore();
  await PilotPresenceSnapshotPublisher(
    store: store,
    now: () => DateTime.utc(2026, 8, 20, 8),
    flags: _flags,
    widgetShowsTitles: showTitles,
  ).publishWidgetSnapshot([_commitment]);
  return store.readSnapshot();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('by default the widget does not name the commitment', () async {
    final snapshot = await _publish(showTitles: false);

    expect(snapshot!.items.single.titleRedacted, isTrue);
    expect(snapshot.items.single.title, isNot(contains('insurance')));
  });

  test('when the user allows titles, the widget can name it', () async {
    final snapshot = await _publish(showTitles: true);

    expect(snapshot!.items.single.titleRedacted, isFalse);
    expect(snapshot.items.single.title, 'Renew the insurance');
  });

  test('allowing titles allows them for the widget and nothing else', () async {
    final snapshot = await _publish(showTitles: true);

    expect(
      snapshot!.titlePrivacy.allowsTitleFor(PilotPresenceSurface.widget),
      isTrue,
    );
    expect(
      snapshot.titlePrivacy.allowsTitleFor(PilotPresenceSurface.watch),
      isFalse,
      reason: 'the watch is a separate surface with its own decision',
    );
  });
}
