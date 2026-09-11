import '../../models/pilot_presence.dart';

abstract interface class PilotPresenceStore {
  static const allowedNativeOperations = {'readSnapshot'};

  Future<CommitmentSnapshot?> readSnapshot();
  Future<void> publishSnapshot(CommitmentSnapshot snapshot);
  Future<void> clearSnapshot();
}

class PilotPresenceStoreKeys {
  static const appGroupIdentifier = 'group.com.maybesitter.maybesitterMobile';
  static const snapshotV1 = 'pilot_presence_commitment_snapshot_v1';
  static const watchEnabledV1 = 'pilot_presence_watch_enabled_v1';

  const PilotPresenceStoreKeys._();
}
