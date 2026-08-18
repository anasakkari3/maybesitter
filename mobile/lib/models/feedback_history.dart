// The user-facing record of what the app observed them doing.
//
// Mirrors `FeedbackHistoryRow` / `FeedbackHistoryResponse` in
// `src/contracts/v1/feedbackContracts.ts`. A row is one observed moment. It
// deliberately carries no summary, no score and no inferred trait: the whole
// point of the screen it feeds is that "we saw you defer this on Tuesday" and
// "you are someone who defers" are different claims, and only the first one
// is something the app is entitled to make.

/// What was observed. [unknown] exists because the server contract may grow an
/// outcome this build has never heard of, and a row we cannot describe must say
/// so rather than be silently dropped or mislabelled as something else.
enum FeedbackOutcome { accept, edit, reject, defer, complete, ignore, undo, unknown }

FeedbackOutcome feedbackOutcomeFromWire(String? value) {
  switch (value) {
    case 'accept':
      return FeedbackOutcome.accept;
    case 'edit':
      return FeedbackOutcome.edit;
    case 'reject':
      return FeedbackOutcome.reject;
    case 'defer':
      return FeedbackOutcome.defer;
    case 'complete':
      return FeedbackOutcome.complete;
    case 'ignore':
      return FeedbackOutcome.ignore;
    case 'undo':
      return FeedbackOutcome.undo;
    default:
      return FeedbackOutcome.unknown;
  }
}

class FeedbackHistoryRow {
  final String id;
  final FeedbackOutcome outcome;
  final String subjectId;
  final DateTime occurredAt;

  /// Set once the user told us to stop learning from this moment. The row is
  /// never removed: the correction has to remain visible to be verifiable.
  final DateTime? revokedAt;

  final bool canRevoke;

  const FeedbackHistoryRow({
    required this.id,
    required this.outcome,
    required this.subjectId,
    required this.occurredAt,
    required this.revokedAt,
    required this.canRevoke,
  });

  bool get isRevoked => revokedAt != null;

  factory FeedbackHistoryRow.fromJson(Map<String, dynamic> json) {
    final revokedAt = json['revokedAt'];
    return FeedbackHistoryRow(
      id: (json['id'] ?? '') as String,
      outcome: feedbackOutcomeFromWire(json['outcome'] as String?),
      subjectId: (json['subjectId'] ?? '') as String,
      occurredAt: DateTime.parse(json['occurredAt'] as String).toLocal(),
      revokedAt: revokedAt is String && revokedAt.isNotEmpty
          ? DateTime.parse(revokedAt).toLocal()
          : null,
      canRevoke: json['canRevoke'] == true,
    );
  }

  FeedbackHistoryRow copyWith({DateTime? revokedAt, bool? canRevoke}) {
    return FeedbackHistoryRow(
      id: id,
      outcome: outcome,
      subjectId: subjectId,
      occurredAt: occurredAt,
      revokedAt: revokedAt ?? this.revokedAt,
      canRevoke: canRevoke ?? this.canRevoke,
    );
  }
}

/// Counts carried over from before the event log existed.
///
/// These have no per-event timestamps, so they can never be shown as moments
/// and can never be turned off one at a time. They are reported anyway: leaving
/// them out would show the user less than the system actually holds.
class FeedbackBaselineNotice {
  final int ignoredSuggestions;
  final int completedActions;
  final int delayedActions;
  final int clarificationSuccesses;
  final int clarificationFailures;
  final DateTime? lastUpdatedAt;

  const FeedbackBaselineNotice({
    this.ignoredSuggestions = 0,
    this.completedActions = 0,
    this.delayedActions = 0,
    this.clarificationSuccesses = 0,
    this.clarificationFailures = 0,
    this.lastUpdatedAt,
  });

  int get total =>
      ignoredSuggestions +
      completedActions +
      delayedActions +
      clarificationSuccesses +
      clarificationFailures;

  factory FeedbackBaselineNotice.fromJson(Map<String, dynamic> json) {
    final counters = (json['counters'] as Map?)?.cast<String, dynamic>() ?? const {};
    int count(String key) {
      final value = counters[key];
      return value is num ? value.toInt() : 0;
    }

    final lastUpdatedAt = json['lastUpdatedAt'];
    return FeedbackBaselineNotice(
      ignoredSuggestions: count('ignoredSuggestions'),
      completedActions: count('completedActions'),
      delayedActions: count('delayedActions'),
      clarificationSuccesses: count('clarificationSuccesses'),
      clarificationFailures: count('clarificationFailures'),
      lastUpdatedAt: lastUpdatedAt is String && lastUpdatedAt.isNotEmpty
          ? DateTime.parse(lastUpdatedAt).toLocal()
          : null,
    );
  }
}

class FeedbackHistory {
  final List<FeedbackHistoryRow> rows;
  final FeedbackBaselineNotice? baselineNotice;

  const FeedbackHistory({required this.rows, this.baselineNotice});

  static const empty = FeedbackHistory(rows: []);

  factory FeedbackHistory.fromJson(Map<String, dynamic> json) {
    final rows = (json['rows'] as List?) ?? const [];
    final baseline = json['baselineNotice'];
    return FeedbackHistory(
      rows: rows
          .whereType<Map>()
          .map((row) => FeedbackHistoryRow.fromJson(row.cast<String, dynamic>()))
          .toList(),
      baselineNotice: baseline is Map
          ? FeedbackBaselineNotice.fromJson(baseline.cast<String, dynamic>())
          : null,
    );
  }
}
