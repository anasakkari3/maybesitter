import '../../l10n/generated/app_localizations.dart';

/// Turns the backend's privacy-safe evidence codes into participant-readable
/// text.
///
/// The codes are a closed vocabulary that never contains user content. An
/// unrecognised code is folded into a single generic line rather than shown
/// raw — a raw code is meaningless to a participant, and echoing an unknown
/// string into the UI is exactly how user text would leak if the vocabulary
/// ever changed.
String? localizeEvidenceLabel(AppLocalizations l10n, String code) {
  switch (code) {
    case 'due_today':
      return l10n.evidenceDueToday;
    case 'overdue':
      return l10n.evidenceOverdue;
    case 'confirmed_by_you':
      return l10n.evidenceConfirmedByYou;
    case 'high_priority':
      return l10n.evidenceHighPriority;
    case 'scheduled_soon':
      return l10n.evidenceScheduledSoon;
    case 'only_open_item':
      return l10n.evidenceOnlyOpenItem;
    default:
      return null;
  }
}

/// Maps a whole evidence list, de-duplicated and order-preserving, collapsing
/// any unknown codes into one generic entry at the end.
List<String> localizeEvidenceLabels(
  AppLocalizations l10n,
  List<String> codes,
) {
  final localized = <String>[];
  var sawUnknown = false;
  for (final code in codes) {
    final label = localizeEvidenceLabel(l10n, code);
    if (label == null) {
      sawUnknown = true;
      continue;
    }
    if (!localized.contains(label)) localized.add(label);
  }
  if (sawUnknown && !localized.contains(l10n.evidenceOther)) {
    localized.add(l10n.evidenceOther);
  }
  return localized;
}
