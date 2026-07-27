import 'package:flutter/material.dart';
import '../../l10n/generated/app_localizations.dart';
import '../../models/commitment.dart';

extension LocalizedBuildContext on BuildContext {
  AppLocalizations get l10n => AppLocalizations.of(this)!;
  String get currentLanguageCode => Localizations.localeOf(this).languageCode;
}

extension PriorityL10n on CommitmentPriority {
  String localizedName(AppLocalizations l10n) {
    switch (this) {
      case CommitmentPriority.must:
        return l10n.priorityMust;
      case CommitmentPriority.should:
        return l10n.priorityShould;
      case CommitmentPriority.nice:
        return l10n.priorityNice;
    }
  }
}

extension CommitmentStatusL10n on CommitmentStatus {
  String localizedStatusName(AppLocalizations l10n) {
    switch (this) {
      case CommitmentStatus.pending:
        return l10n.statusPending;
      case CommitmentStatus.completed:
        return l10n.statusCompleted;
      case CommitmentStatus.postponed:
        return l10n.statusPostponed;
      case CommitmentStatus.cancelled:
        return l10n.statusCancelled;
    }
  }
}
