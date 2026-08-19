import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../../models/commitment.dart';

/// Where the mock repository keeps what the user did between launches.
///
/// Mock mode seeds a demo day and holds it in memory, which is right for a
/// demo and wrong for someone actually using the app: completing every
/// commitment produced the empty state, and relaunching brought all three
/// back. Nothing was broken — there was simply nowhere for the answer to go.
///
/// The store holds *changes*, not the corpus. Seed data still comes from the
/// repository, so a later seed edit is picked up rather than frozen into a
/// user's saved copy; only the fields a person can actually change are
/// restored over it.
abstract class CommitmentStateStore {
  Future<Map<String, CommitmentStateChange>> load();
  Future<void> save(Map<String, CommitmentStateChange> changes);
}

/// The part of a commitment a user can change, and nothing else.
///
/// Deliberately not the whole `Commitment`: persisting the entire object would
/// mean a change to the seeded title or location never reaches anyone who had
/// once opened the app.
class CommitmentStateChange {
  final CommitmentStatus status;
  final DateTime? scheduledDate;
  final DateTime? completedAt;

  const CommitmentStateChange({
    required this.status,
    this.scheduledDate,
    this.completedAt,
  });

  Map<String, dynamic> toJson() => {
    'status': status.name,
    'scheduledDate': scheduledDate?.toIso8601String(),
    'completedAt': completedAt?.toIso8601String(),
  };

  static CommitmentStateChange? fromJson(Map<String, dynamic> json) {
    final statusName = json['status'] as String?;
    if (statusName == null) return null;
    CommitmentStatus? status;
    for (final candidate in CommitmentStatus.values) {
      if (candidate.name == statusName) status = candidate;
    }
    // An unknown status means the app that wrote it is newer than the one
    // reading it. Dropping the row restores the seed rather than crashing or
    // inventing a state this build does not have.
    if (status == null) return null;
    return CommitmentStateChange(
      status: status,
      scheduledDate: _parseDate(json['scheduledDate']),
      completedAt: _parseDate(json['completedAt']),
    );
  }

  static DateTime? _parseDate(dynamic value) {
    if (value is! String || value.isEmpty) return null;
    return DateTime.tryParse(value);
  }
}

/// Test double: the same contract, backed by a plain map.
class InMemoryStateStore implements CommitmentStateStore {
  Map<String, CommitmentStateChange> _changes = {};

  @override
  Future<Map<String, CommitmentStateChange>> load() async => Map.of(_changes);

  @override
  Future<void> save(Map<String, CommitmentStateChange> changes) async {
    _changes = Map.of(changes);
  }
}

/// The real one. Shares `SharedPreferences` with the settings the app already
/// persists, so there is one storage mechanism rather than two.
class PreferencesStateStore implements CommitmentStateStore {
  static const _key = 'commitment_state_changes_v1';

  @override
  Future<Map<String, CommitmentStateChange>> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw == null || raw.isEmpty) return {};

    // A corrupt or half-written blob restores the seed instead of taking the
    // app down on launch — the data is a convenience, not a source of truth.
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return {};
      final result = <String, CommitmentStateChange>{};
      decoded.forEach((key, value) {
        if (key is String && value is Map) {
          final change = CommitmentStateChange.fromJson(
            Map<String, dynamic>.from(value),
          );
          if (change != null) result[key] = change;
        }
      });
      return result;
    } catch (_) {
      return {};
    }
  }

  @override
  Future<void> save(Map<String, CommitmentStateChange> changes) async {
    final prefs = await SharedPreferences.getInstance();
    final encoded = jsonEncode(
      changes.map((id, change) => MapEntry(id, change.toJson())),
    );
    await prefs.setString(_key, encoded);
  }
}
