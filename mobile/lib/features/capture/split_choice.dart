import 'package:flutter/foundation.dart';

import '../../models/commitment.dart';

/// Which reading a set of commitments came from.
enum SplitSource { agreed, localOnly, remoteOnly }

@immutable
class SplitOption {
  final SplitSource source;
  final List<Commitment> commitments;

  const SplitOption({required this.source, required this.commitments});
}

/// What to show after a capture.
///
/// When both models read the sentence the same way there is nothing to ask
/// about. When they disagree the user picks, because a split neither the
/// person nor a deterministic rule chose must not become their schedule.
@immutable
class SplitChoice {
  final List<SplitOption> options;
  final bool needsUserChoice;

  const SplitChoice({required this.options, required this.needsUserChoice});
}

/// Compare two readings of one sentence and decide whether the user has to
/// arbitrate between them.
///
/// Counting commitments is not enough. The arbitration verdict carries
/// `correctedTimes` precisely because two readings can agree that a sentence
/// holds two commitments and still disagree about when they are -- "على
/// السبعة" is seven in the morning or seven in the evening. Shipping the
/// local guess whenever the counts happen to match would make exactly that
/// class of error invisible.
SplitChoice buildSplitChoice({
  required List<Commitment> local,
  List<Commitment>? remote,
}) {
  final usableRemote = _usableReading(remote);

  // No arbitration happened, it came back unusable, or the two readings say
  // the same thing: the local reading stands and nothing is asked.
  if (usableRemote == null || !_readingsDisagree(local, usableRemote)) {
    return SplitChoice(
      options: [SplitOption(source: SplitSource.agreed, commitments: local)],
      needsUserChoice: false,
    );
  }

  return SplitChoice(
    options: [
      // Local first: it is what the device produced without sending anything.
      SplitOption(source: SplitSource.localOnly, commitments: local),
      SplitOption(source: SplitSource.remoteOnly, commitments: usableRemote),
    ],
    needsUserChoice: true,
  );
}

/// The remote reading with anything unshowable removed, or `null` when
/// nothing usable is left.
///
/// A titleless commitment is not something a person can choose between, so it
/// is dropped before the counts are compared rather than after -- otherwise a
/// malformed remote answer would manufacture a disagreement out of padding.
List<Commitment>? _usableReading(List<Commitment>? remote) {
  if (remote == null) return null;
  final usable = remote.where((c) => c.title.trim().isNotEmpty).toList();
  return usable.isEmpty ? null : usable;
}

bool _readingsDisagree(List<Commitment> local, List<Commitment> remote) {
  if (local.length != remote.length) return true;

  // Same count, so the readings are comparable position by position: the
  // arbiter answers about the commitments in the order they appear in the
  // sentence, and its ids are its own.
  for (var i = 0; i < local.length; i++) {
    if (_timesDisagree(local[i], remote[i])) return true;
  }
  return false;
}

/// Whether two readings of the same commitment make conflicting time claims.
///
/// Only a claim can conflict with a claim. A reading that says nothing about
/// the day, or nothing about the clock, is silent rather than contradictory --
/// the arbiter is allowed to correct a split and return no times at all, and
/// treating that silence as "no time" would raise a dispute on every
/// count-only verdict and teach the user to tap through them.
bool _timesDisagree(Commitment a, Commitment b) {
  final dayA = _day(a);
  final dayB = _day(b);
  if (dayA != null && dayB != null && dayA != dayB) return true;

  final clockA = _minuteOfDay(a);
  final clockB = _minuteOfDay(b);
  if (clockA != null && clockB != null && clockA != clockB) return true;

  return false;
}

/// The calendar day a reading pins, or `null` when it pins none.
String? _day(Commitment c) {
  final date = c.scheduledDate;
  if (date == null) return null;
  return '${date.year}-${date.month}-${date.day}';
}

/// The minute of the day a reading pins, or `null` when it pins none.
///
/// `startTime` wins over `scheduledDate` because it is the field a second
/// reading fills in when it corrects a time; `scheduledDate` is the fallback
/// for a reading that only ever carried an instant.
int? _minuteOfDay(Commitment c) {
  // A date-only or all-day reading still carries a midnight `scheduledDate`.
  // That midnight is an artefact of the type, not a claim about the clock.
  if (c.timeGranularity == TimeGranularity.dateOnly ||
      c.timeGranularity == TimeGranularity.fullDay) {
    return null;
  }

  final fromClock = _parseClock(c.startTime);
  if (fromClock != null) return fromClock;

  final date = c.scheduledDate;
  if (date == null) return null;

  // `timeGranularity` defaults to exact, so a producer that sets a date and
  // never sets a clock reaches here with the same midnight artefact the branch
  // above exists to ignore. Treating it as a 00:00 claim manufactured disputes
  // out of readings that pinned no time at all.
  if (date.hour == 0 && date.minute == 0) return null;

  return date.hour * 60 + date.minute;
}

/// Parse `H:MM`, `HH:MM`, `HH:MM:SS` or `H:MM AM/PM` into minutes past midnight.
///
/// Normalising first means '7:00' and '07:00' compare equal: a formatting
/// difference is not a disagreement worth interrupting anyone for.
///
/// The meridiem form is not optional. `Commitment.startTime` really does carry
/// '7:00 PM' -- soft_awareness_reminder_engine.dart and commitment_edit_sheet
/// both parse it -- and a parser that returns null for it reads as "this
/// reading pins no time", so '7:00 PM' against '19:00' silently shipped the
/// local guess. That is exactly the AM/PM confusion this file exists to catch.
/// Those two other parsers should migrate here; until they do this is the one
/// that must not be the weakest.
int? _parseClock(String? raw) {
  final text = raw?.trim().toUpperCase();
  if (text == null || text.isEmpty) return null;

  final meridiem = RegExp(r'^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$').firstMatch(text);
  if (meridiem != null) {
    var hour = int.parse(meridiem.group(1)!);
    final minute = int.parse(meridiem.group(2)!);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (meridiem.group(3) == 'P' && hour != 12) hour += 12;
    if (meridiem.group(3) == 'A' && hour == 12) hour = 0;
    return hour * 60 + minute;
  }

  final match = RegExp(r'^(\d{1,2}):(\d{2})(?::\d{2})?$').firstMatch(text);
  if (match == null) return null;

  final hour = int.parse(match.group(1)!);
  final minute = int.parse(match.group(2)!);
  if (hour > 23 || minute > 59) return null;

  return hour * 60 + minute;
}
