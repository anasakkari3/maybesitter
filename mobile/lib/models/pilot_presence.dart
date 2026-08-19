import 'package:flutter/foundation.dart';

import 'commitment.dart';

enum PilotPresenceSurface {
  widget,
  watch,
  notification;

  String get surfaceId => name;
}

enum SnapshotTitlePrivacyMode {
  neverIncludeTitles,
  allowedSurfacesOnly,
  explicitlyAllowed,
}

enum SnapshotRedactionReason { none, titlesDisabled, surfaceNotAllowed }

enum CommitmentSnapshotDisplayState { empty, populated, stale }

@immutable
class SnapshotTitlePrivacy {
  final SnapshotTitlePrivacyMode mode;
  final Set<String> allowedSurfaceIds;

  const SnapshotTitlePrivacy({
    required this.mode,
    this.allowedSurfaceIds = const {},
  });

  bool allowsTitleFor(PilotPresenceSurface surface) {
    switch (mode) {
      case SnapshotTitlePrivacyMode.neverIncludeTitles:
        return false;
      case SnapshotTitlePrivacyMode.allowedSurfacesOnly:
      case SnapshotTitlePrivacyMode.explicitlyAllowed:
        return allowedSurfaceIds.contains(surface.surfaceId);
    }
  }

  SnapshotRedactionReason redactionReasonFor(PilotPresenceSurface surface) {
    if (allowsTitleFor(surface)) return SnapshotRedactionReason.none;
    if (mode == SnapshotTitlePrivacyMode.neverIncludeTitles) {
      return SnapshotRedactionReason.titlesDisabled;
    }
    return SnapshotRedactionReason.surfaceNotAllowed;
  }

  Map<String, dynamic> toJson() {
    return {
      'mode': mode.name,
      'allowedSurfaceIds': allowedSurfaceIds.toList()..sort(),
    };
  }

  factory SnapshotTitlePrivacy.fromJson(Map<String, dynamic> json) {
    return SnapshotTitlePrivacy(
      mode: _enumByName(
        SnapshotTitlePrivacyMode.values,
        json['mode'],
        SnapshotTitlePrivacyMode.neverIncludeTitles,
      ),
      allowedSurfaceIds: _stringSet(json['allowedSurfaceIds']),
    );
  }
}

@immutable
class CommitmentSnapshotItem {
  static const redactedTitle = 'Private commitment';

  final String id;
  final String title;
  final bool titleRedacted;
  final SnapshotRedactionReason redactionReason;
  final CommitmentPriority priority;
  final CommitmentStatus status;
  final TimeGranularity timeGranularity;
  final DateTime? scheduledDate;
  final String? startTime;
  final String? endTime;
  final String? category;

  const CommitmentSnapshotItem({
    required this.id,
    required this.title,
    required this.titleRedacted,
    required this.redactionReason,
    required this.priority,
    this.status = CommitmentStatus.pending,
    this.timeGranularity = TimeGranularity.exact,
    this.scheduledDate,
    this.startTime,
    this.endTime,
    this.category,
  });

  bool get sourceCanMutateCanonicalState => false;

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'titleRedacted': titleRedacted,
      'redactionReason': redactionReason.name,
      'priority': priority.name,
      'status': status.name,
      'timeGranularity': timeGranularity.name,
      'scheduledDate': scheduledDate?.toIso8601String(),
      'startTime': startTime,
      'endTime': endTime,
      'category': category,
      'sourceCanMutateCanonicalState': false,
    };
  }

  CommitmentSnapshotItem redactedFor({
    required PilotPresenceSurface surface,
    required SnapshotTitlePrivacy titlePrivacy,
  }) {
    final reason = titlePrivacy.redactionReasonFor(surface);
    if (reason == SnapshotRedactionReason.none) return this;
    return CommitmentSnapshotItem(
      id: id,
      title: redactedTitle,
      titleRedacted: true,
      redactionReason: reason,
      priority: priority,
      status: status,
      timeGranularity: timeGranularity,
      scheduledDate: scheduledDate,
      startTime: startTime,
      endTime: endTime,
      category: category,
    );
  }

  factory CommitmentSnapshotItem.fromJson(Map<String, dynamic> json) {
    return CommitmentSnapshotItem(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? redactedTitle,
      titleRedacted: json['titleRedacted'] as bool? ?? true,
      redactionReason: _enumByName(
        SnapshotRedactionReason.values,
        json['redactionReason'],
        SnapshotRedactionReason.titlesDisabled,
      ),
      priority: _enumByName(
        CommitmentPriority.values,
        json['priority'],
        CommitmentPriority.should,
      ),
      status: _enumByName(
        CommitmentStatus.values,
        json['status'],
        CommitmentStatus.unknown,
      ),
      timeGranularity: _enumByName(
        TimeGranularity.values,
        json['timeGranularity'],
        TimeGranularity.exact,
      ),
      scheduledDate: _parseDate(json['scheduledDate']),
      startTime: json['startTime'] as String?,
      endTime: json['endTime'] as String?,
      category: json['category'] as String?,
    );
  }

  factory CommitmentSnapshotItem.fromCommitment({
    required Commitment commitment,
    required PilotPresenceSurface surface,
    required SnapshotTitlePrivacy titlePrivacy,
  }) {
    final reason = titlePrivacy.redactionReasonFor(surface);
    final titleAllowed = reason == SnapshotRedactionReason.none;
    return CommitmentSnapshotItem(
      id: commitment.id,
      title: titleAllowed ? commitment.title : redactedTitle,
      titleRedacted: !titleAllowed,
      redactionReason: reason,
      priority: commitment.priority,
      status: commitment.status,
      timeGranularity: commitment.timeGranularity,
      scheduledDate: commitment.scheduledDate,
      startTime: commitment.startTime,
      endTime: commitment.endTime,
      category: commitment.category,
    );
  }
}

@immutable
class CommitmentSnapshot {
  static const currentSchemaVersion = 1;

  final int schemaVersion;
  final DateTime generatedAt;
  final DateTime expiresAt;
  final PilotPresenceSurface surface;
  final SnapshotTitlePrivacy titlePrivacy;
  final List<CommitmentSnapshotItem> items;

  const CommitmentSnapshot({
    required this.schemaVersion,
    required this.generatedAt,
    required this.expiresAt,
    required this.surface,
    required this.titlePrivacy,
    required this.items,
  });

  factory CommitmentSnapshot.fromCommitments({
    required List<Commitment> commitments,
    required DateTime generatedAt,
    required DateTime expiresAt,
    required PilotPresenceSurface surface,
    required SnapshotTitlePrivacy titlePrivacy,
  }) {
    return CommitmentSnapshot(
      schemaVersion: currentSchemaVersion,
      generatedAt: generatedAt,
      expiresAt: expiresAt,
      surface: surface,
      titlePrivacy: titlePrivacy,
      items: commitments
          .map(
            (commitment) => CommitmentSnapshotItem.fromCommitment(
              commitment: commitment,
              surface: surface,
              titlePrivacy: titlePrivacy,
            ),
          )
          .toList(growable: false),
    );
  }

  bool isStale(DateTime now) => !now.isBefore(expiresAt);

  CommitmentSnapshotDisplayState displayState(DateTime now) {
    if (isStale(now)) return CommitmentSnapshotDisplayState.stale;
    if (items.isEmpty) return CommitmentSnapshotDisplayState.empty;
    return CommitmentSnapshotDisplayState.populated;
  }

  List<CommitmentSnapshotItem> safeItemsForDisplay(DateTime now) {
    if (isStale(now)) return const [];
    return List.unmodifiable(_itemsSafeForSurface());
  }

  Map<String, dynamic> toJson() {
    return {
      'contract': 'commitmentSnapshot',
      'schemaVersion': schemaVersion,
      'generatedAt': generatedAt.toIso8601String(),
      'expiresAt': expiresAt.toIso8601String(),
      'surface': surface.name,
      'titlePrivacy': titlePrivacy.toJson(),
      'items': _itemsSafeForSurface()
          .map((item) => item.toJson())
          .toList(growable: false),
    };
  }

  List<CommitmentSnapshotItem> _itemsSafeForSurface() {
    return items
        .map(
          (item) =>
              item.redactedFor(surface: surface, titlePrivacy: titlePrivacy),
        )
        .toList(growable: false);
  }

  factory CommitmentSnapshot.fromJson(Map<String, dynamic> json) {
    final surface = _enumByName(
      PilotPresenceSurface.values,
      json['surface'],
      PilotPresenceSurface.widget,
    );
    final titlePrivacy = json['titlePrivacy'] is Map
        ? SnapshotTitlePrivacy.fromJson(
            Map<String, dynamic>.from(json['titlePrivacy'] as Map),
          )
        : const SnapshotTitlePrivacy(
            mode: SnapshotTitlePrivacyMode.neverIncludeTitles,
          );
    return CommitmentSnapshot(
      schemaVersion:
          (json['schemaVersion'] as num?)?.toInt() ?? currentSchemaVersion,
      generatedAt:
          _parseDate(json['generatedAt']) ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      expiresAt:
          _parseDate(json['expiresAt']) ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      surface: surface,
      titlePrivacy: titlePrivacy,
      items: _itemList(json['items'])
          .map(
            (item) =>
                item.redactedFor(surface: surface, titlePrivacy: titlePrivacy),
          )
          .toList(growable: false),
    );
  }
}

enum ReminderIntensity { none, softAwareness, followUp, strongReminder }

enum QuietHoursRespectMode {
  alwaysDefer,
  deferUnlessMustAndAllowed,
  allowUserOverride,
}

@immutable
class ReminderScheduleDecision {
  final ReminderIntensity intensity;
  final Duration leadTime;
  final bool requiresExplicitOptIn;
  final bool respectsQuietHours;

  const ReminderScheduleDecision({
    required this.intensity,
    required this.leadTime,
    required this.requiresExplicitOptIn,
    required this.respectsQuietHours,
  });
}

/// One timed step in a commitment's reminder sequence.
///
/// A commitment is not reminded once. It is reminded softly first, and then --
/// only if the user never acknowledged it -- escalated closer to the event.
/// Each step is its own stage so that acknowledging the soft stage can cancel
/// the later ones without cancelling the concept of the reminder.
@immutable
class ReminderStage {
  final ReminderIntensity intensity;
  final Duration leadTime;
  final bool respectsQuietHours;

  /// Whether acknowledging awareness cancels this stage.
  ///
  /// The opening soft stage is what asks for awareness, so it is never
  /// suppressed by awareness. Every escalation after it exists only because
  /// awareness was missing, so awareness cancels it.
  final bool suppressedByAwareness;

  const ReminderStage({
    required this.intensity,
    required this.leadTime,
    required this.respectsQuietHours,
    required this.suppressedByAwareness,
  });
}

/// The full ordered reminder sequence for one commitment, soft stage first.
@immutable
class ReminderPlan {
  final List<ReminderStage> stages;

  const ReminderPlan({required this.stages});

  static const empty = ReminderPlan(stages: []);

  bool get isEmpty => stages.isEmpty;
}

@immutable
class ReminderPolicy {
  static const currentSchemaVersion = 1;

  final int schemaVersion;
  final ReminderIntensity maxIntensity;
  final Duration softAwarenessLeadTime;
  final Duration followUpLeadTime;
  final Duration strongReminderLeadTime;
  final bool strongRemindersRequireExplicitOptIn;
  final QuietHoursRespectMode quietHoursRespectMode;

  const ReminderPolicy({
    this.schemaVersion = currentSchemaVersion,
    this.maxIntensity = ReminderIntensity.softAwareness,
    this.softAwarenessLeadTime = const Duration(hours: 1),
    this.followUpLeadTime = const Duration(minutes: 30),
    this.strongReminderLeadTime = const Duration(minutes: 10),
    this.strongRemindersRequireExplicitOptIn = true,
    this.quietHoursRespectMode = QuietHoursRespectMode.alwaysDefer,
  });

  /// The ordered reminder sequence for [commitment].
  ///
  /// Stages run from the softest and earliest to the strongest and latest, so
  /// each stage is strictly closer to the event than the one before it.
  ReminderPlan planFor(Commitment commitment) {
    final ceiling = _capIntensity(_ceilingFor(commitment.priority));
    if (ceiling == ReminderIntensity.none) return ReminderPlan.empty;

    final respectsQuietHours =
        quietHoursRespectMode != QuietHoursRespectMode.allowUserOverride;

    ReminderStage stage(ReminderIntensity intensity, {required bool escalation}) {
      return ReminderStage(
        intensity: intensity,
        leadTime: _leadTimeFor(intensity),
        respectsQuietHours: respectsQuietHours,
        suppressedByAwareness: escalation,
      );
    }

    // Every plan opens by asking for awareness, then escalates at most once.
    // A ladder of three notifications for a single commitment is the noise
    // this product exists to avoid.
    final stages = <ReminderStage>[
      stage(ReminderIntensity.softAwareness, escalation: false),
    ];

    final escalatesTo = ceiling;
    final blockedByOptIn =
        escalatesTo == ReminderIntensity.strongReminder &&
        strongRemindersRequireExplicitOptIn;
    if (_intensityRank(escalatesTo) >
            _intensityRank(ReminderIntensity.softAwareness) &&
        !blockedByOptIn) {
      stages.add(stage(escalatesTo, escalation: true));
    }

    return ReminderPlan(stages: List.unmodifiable(stages));
  }

  /// The strongest reminder a priority is ever allowed to reach.
  ReminderIntensity _ceilingFor(CommitmentPriority priority) {
    return switch (priority) {
      CommitmentPriority.must => ReminderIntensity.strongReminder,
      CommitmentPriority.should => ReminderIntensity.followUp,
      CommitmentPriority.nice => ReminderIntensity.softAwareness,
    };
  }

  ReminderScheduleDecision decisionFor(Commitment commitment) {
    final requestedIntensity = switch (commitment.priority) {
      CommitmentPriority.must => maxIntensity,
      CommitmentPriority.should =>
        maxIntensity == ReminderIntensity.strongReminder
            ? ReminderIntensity.followUp
            : maxIntensity,
      CommitmentPriority.nice =>
        maxIntensity == ReminderIntensity.none
            ? ReminderIntensity.none
            : ReminderIntensity.softAwareness,
    };
    final intensity = _capIntensity(requestedIntensity);
    return ReminderScheduleDecision(
      intensity: intensity,
      leadTime: _leadTimeFor(intensity),
      requiresExplicitOptIn:
          intensity == ReminderIntensity.strongReminder &&
          strongRemindersRequireExplicitOptIn,
      respectsQuietHours:
          quietHoursRespectMode != QuietHoursRespectMode.allowUserOverride,
    );
  }

  ReminderPolicy copyWith({
    int? schemaVersion,
    ReminderIntensity? maxIntensity,
    Duration? softAwarenessLeadTime,
    Duration? followUpLeadTime,
    Duration? strongReminderLeadTime,
    bool? strongRemindersRequireExplicitOptIn,
    QuietHoursRespectMode? quietHoursRespectMode,
  }) {
    return ReminderPolicy(
      schemaVersion: schemaVersion ?? this.schemaVersion,
      maxIntensity: maxIntensity ?? this.maxIntensity,
      softAwarenessLeadTime:
          softAwarenessLeadTime ?? this.softAwarenessLeadTime,
      followUpLeadTime: followUpLeadTime ?? this.followUpLeadTime,
      strongReminderLeadTime:
          strongReminderLeadTime ?? this.strongReminderLeadTime,
      strongRemindersRequireExplicitOptIn:
          strongRemindersRequireExplicitOptIn ??
          this.strongRemindersRequireExplicitOptIn,
      quietHoursRespectMode:
          quietHoursRespectMode ?? this.quietHoursRespectMode,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'contract': 'reminderPolicy',
      'schemaVersion': schemaVersion,
      'maxIntensity': maxIntensity.name,
      'softAwarenessLeadMinutes': softAwarenessLeadTime.inMinutes,
      'followUpLeadMinutes': followUpLeadTime.inMinutes,
      'strongReminderLeadMinutes': strongReminderLeadTime.inMinutes,
      'strongRemindersRequireExplicitOptIn':
          strongRemindersRequireExplicitOptIn,
      'quietHoursRespectMode': quietHoursRespectMode.name,
    };
  }

  factory ReminderPolicy.fromJson(Map<String, dynamic> json) {
    return ReminderPolicy(
      schemaVersion:
          (json['schemaVersion'] as num?)?.toInt() ?? currentSchemaVersion,
      maxIntensity: _enumByName(
        ReminderIntensity.values,
        json['maxIntensity'],
        ReminderIntensity.softAwareness,
      ),
      softAwarenessLeadTime: Duration(
        minutes: (json['softAwarenessLeadMinutes'] as num?)?.toInt() ?? 60,
      ),
      followUpLeadTime: Duration(
        minutes: (json['followUpLeadMinutes'] as num?)?.toInt() ?? 30,
      ),
      strongReminderLeadTime: Duration(
        minutes: (json['strongReminderLeadMinutes'] as num?)?.toInt() ?? 10,
      ),
      strongRemindersRequireExplicitOptIn:
          json['strongRemindersRequireExplicitOptIn'] as bool? ?? true,
      quietHoursRespectMode: _enumByName(
        QuietHoursRespectMode.values,
        json['quietHoursRespectMode'],
        QuietHoursRespectMode.alwaysDefer,
      ),
    );
  }

  ReminderIntensity _capIntensity(ReminderIntensity requested) {
    return _intensityRank(requested) <= _intensityRank(maxIntensity)
        ? requested
        : maxIntensity;
  }

  Duration _leadTimeFor(ReminderIntensity intensity) {
    return switch (intensity) {
      ReminderIntensity.none => Duration.zero,
      ReminderIntensity.softAwareness => softAwarenessLeadTime,
      ReminderIntensity.followUp => followUpLeadTime,
      ReminderIntensity.strongReminder => strongReminderLeadTime,
    };
  }
}

@immutable
class RoutineTimeWindow {
  final String start;
  final String end;
  final String? label;

  const RoutineTimeWindow({required this.start, required this.end, this.label});

  RoutineTimeWindow copyWith({String? start, String? end, String? label}) {
    return RoutineTimeWindow(
      start: start ?? this.start,
      end: end ?? this.end,
      label: label ?? this.label,
    );
  }

  Map<String, dynamic> toJson() {
    return {'start': start, 'end': end, 'label': label};
  }

  factory RoutineTimeWindow.fromJson(Map<String, dynamic> json) {
    return RoutineTimeWindow(
      start: json['start'] as String? ?? '00:00',
      end: json['end'] as String? ?? '00:00',
      label: json['label'] as String?,
    );
  }
}

@immutable
class UserRoutineProfile {
  static const currentSchemaVersion = 1;

  final int schemaVersion;
  final DateTime updatedAt;
  final String timezone;
  final RoutineTimeWindow? sleepWindow;
  final List<RoutineTimeWindow> focusWindows;
  final List<RoutineTimeWindow> fixedCommitmentWindows;
  final ReminderIntensity preferredReminderIntensity;
  final RoutineTimeWindow? quietHours;
  final bool surveySkipped;

  const UserRoutineProfile({
    this.schemaVersion = currentSchemaVersion,
    required this.updatedAt,
    required this.timezone,
    this.sleepWindow,
    this.focusWindows = const [],
    this.fixedCommitmentWindows = const [],
    this.preferredReminderIntensity = ReminderIntensity.softAwareness,
    this.quietHours,
    this.surveySkipped = false,
  });

  UserRoutineProfile copyWith({
    int? schemaVersion,
    DateTime? updatedAt,
    String? timezone,
    RoutineTimeWindow? sleepWindow,
    List<RoutineTimeWindow>? focusWindows,
    List<RoutineTimeWindow>? fixedCommitmentWindows,
    ReminderIntensity? preferredReminderIntensity,
    RoutineTimeWindow? quietHours,
    bool? surveySkipped,
  }) {
    return UserRoutineProfile(
      schemaVersion: schemaVersion ?? this.schemaVersion,
      updatedAt: updatedAt ?? this.updatedAt,
      timezone: timezone ?? this.timezone,
      sleepWindow: sleepWindow ?? this.sleepWindow,
      focusWindows: focusWindows ?? this.focusWindows,
      fixedCommitmentWindows:
          fixedCommitmentWindows ?? this.fixedCommitmentWindows,
      preferredReminderIntensity:
          preferredReminderIntensity ?? this.preferredReminderIntensity,
      quietHours: quietHours ?? this.quietHours,
      surveySkipped: surveySkipped ?? this.surveySkipped,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'contract': 'userRoutineProfile',
      'schemaVersion': schemaVersion,
      'updatedAt': updatedAt.toIso8601String(),
      'timezone': timezone,
      'sleepWindow': sleepWindow?.toJson(),
      'focusWindows': focusWindows
          .map((window) => window.toJson())
          .toList(growable: false),
      'fixedCommitmentWindows': fixedCommitmentWindows
          .map((window) => window.toJson())
          .toList(growable: false),
      'preferredReminderIntensity': preferredReminderIntensity.name,
      'quietHours': quietHours?.toJson(),
      'surveySkipped': surveySkipped,
    };
  }

  factory UserRoutineProfile.fromJson(Map<String, dynamic> json) {
    return UserRoutineProfile(
      schemaVersion:
          (json['schemaVersion'] as num?)?.toInt() ?? currentSchemaVersion,
      updatedAt:
          _parseDate(json['updatedAt']) ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      timezone: json['timezone'] as String? ?? 'Asia/Jerusalem',
      sleepWindow: _window(json['sleepWindow']),
      focusWindows: _windowList(json['focusWindows']),
      fixedCommitmentWindows: _windowList(json['fixedCommitmentWindows']),
      preferredReminderIntensity: _enumByName(
        ReminderIntensity.values,
        json['preferredReminderIntensity'],
        ReminderIntensity.softAwareness,
      ),
      quietHours: _window(json['quietHours']),
      surveySkipped: json['surveySkipped'] as bool? ?? false,
    );
  }
}

T _enumByName<T extends Enum>(List<T> values, dynamic value, T fallback) {
  if (value is! String) return fallback;
  for (final candidate in values) {
    if (candidate.name == value) return candidate;
  }
  return fallback;
}

DateTime? _parseDate(dynamic value) {
  if (value is! String || value.isEmpty) return null;
  return DateTime.tryParse(value);
}

Set<String> _stringSet(dynamic value) {
  if (value is! List) return const {};
  return value.whereType<String>().toSet();
}

List<CommitmentSnapshotItem> _itemList(dynamic value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map(
        (item) =>
            CommitmentSnapshotItem.fromJson(Map<String, dynamic>.from(item)),
      )
      .toList(growable: false);
}

RoutineTimeWindow? _window(dynamic value) {
  if (value is! Map) return null;
  return RoutineTimeWindow.fromJson(Map<String, dynamic>.from(value));
}

List<RoutineTimeWindow> _windowList(dynamic value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map(
        (window) =>
            RoutineTimeWindow.fromJson(Map<String, dynamic>.from(window)),
      )
      .toList(growable: false);
}

int _intensityRank(ReminderIntensity intensity) {
  return switch (intensity) {
    ReminderIntensity.none => 0,
    ReminderIntensity.softAwareness => 1,
    ReminderIntensity.followUp => 2,
    ReminderIntensity.strongReminder => 3,
  };
}
