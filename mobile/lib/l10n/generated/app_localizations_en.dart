// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appName => 'Maybesitter';

  @override
  String get todayTab => 'Today';

  @override
  String get upcomingTab => 'Upcoming';

  @override
  String get activityTab => 'Activity';

  @override
  String get settingsTab => 'Settings';

  @override
  String goodMorningUser(String userName) {
    return 'Good morning, $userName';
  }

  @override
  String commitmentsCountToday(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count commitments remaining for today',
      one: '1 commitment remaining for today',
      zero: 'No active commitments today',
    );
    return '$_temp0';
  }

  @override
  String get priorityMust => 'MUST';

  @override
  String get priorityShould => 'SHOULD';

  @override
  String get priorityNice => 'NICE';

  @override
  String get priorityFilterAll => 'All';

  @override
  String get statusPending => 'Pending';

  @override
  String get statusCompleted => 'Completed';

  @override
  String get statusPostponed => 'Postponed';

  @override
  String get statusCancelled => 'Cancelled';

  @override
  String get statusUnknown => 'Unknown';

  @override
  String get newIntentTitle => 'New Intent';

  @override
  String get captureHintText =>
      'Type or speak freely. Maybesitter extracts commitments, times, and priorities automatically.';

  @override
  String get composerInputHint =>
      'e.g. \"Tomorrow morning at 9am doctor visit, then meet Sarah for coffee at 2pm...\"';

  @override
  String get voiceCaptureTooltip => 'Voice Capture';

  @override
  String get voiceCaptureStopTooltip => 'Stop Recording';

  @override
  String get editingDisabledExplanation =>
      'Editing is temporarily unavailable to protect your scheduled time.';

  @override
  String get privacyNote =>
      'Your plan is analyzed privately with Quiet Intelligence.';

  @override
  String get analyzeAction => 'Analyze';

  @override
  String get reviewPlanTitle => 'Review Your Plan';

  @override
  String proposedCommitmentsCount(int count) {
    return 'Proposed Commitments ($count)';
  }

  @override
  String confirmCommitmentsAction(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count Commitments',
      one: '1 Commitment',
    );
    return 'Confirm $_temp0';
  }

  @override
  String get cancelPlanAction => 'Cancel Entire Plan';

  @override
  String get editCommitmentTitle => 'Edit Commitment';

  @override
  String get clarificationTitle => 'Clarification';

  @override
  String get clarificationCardHeader => 'Clarification Needed';

  @override
  String get noCommitmentTitle => 'Nothing Found';

  @override
  String get noCommitmentDescription =>
      'I understood the message, but I could not find a plan or actionable commitment to save.';

  @override
  String get extractionErrorTitle => 'Extraction Error';

  @override
  String get extractionErrorMessage =>
      'The AI was unable to parse your plan. Please try again.';

  @override
  String commitmentsAddedSuccess(int count, String date) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Added $count commitments for $date.',
      one: 'Added 1 commitment for $date.',
    );
    return '$_temp0';
  }

  @override
  String get quietIntelligenceSubtitle =>
      'Your schedule has been updated with Quiet Intelligence.';

  @override
  String get viewTomorrowAction => 'View Tomorrow';

  @override
  String get doneAction => 'Done';

  @override
  String get undoAction => 'Undo';

  @override
  String get undoSuccessMessage => 'Saved commitments undone.';

  @override
  String get commitmentDetailTitle => 'Commitment Detail';

  @override
  String get scheduledDateLabel => 'Scheduled Date';

  @override
  String get timeLabel => 'Time';

  @override
  String get locationLabel => 'Location';

  @override
  String get categoryLabel => 'Category';

  @override
  String get markCompleteAction => 'Mark as Complete';

  @override
  String get markPendingAction => 'Mark as Pending';

  @override
  String get postponeAction => 'Postpone Commitment';

  @override
  String get deleteAction => 'Delete';

  @override
  String get deleteConfirmationTitle => 'Delete Commitment';

  @override
  String deleteConfirmationMessage(String title) {
    return 'Are you sure you want to delete \"$title\"? This cannot be undone.';
  }

  @override
  String get postponeSheetTitle => 'Postpone Commitment';

  @override
  String get postponeOneHour => '1 Hour Later';

  @override
  String get postponeThreeHours => '3 Hours Later';

  @override
  String get postponeTomorrowMorning => 'Tomorrow Morning';

  @override
  String get postponeNextWeek => 'Next Week';

  @override
  String get settingsTitle => 'Settings';

  @override
  String get settingsSubtitle => 'App preferences & account';

  @override
  String get appearanceTitle => 'Appearance';

  @override
  String get appearanceSubtitle => 'Theme preferences';

  @override
  String get themeModeLabel => 'Theme Mode';

  @override
  String get themeSystem => 'System';

  @override
  String get themeLight => 'Light';

  @override
  String get themeDark => 'Dark';

  @override
  String get notificationsTitle => 'Notifications';

  @override
  String get notificationsSubtitle => 'Reminders & quiet updates';

  @override
  String get notificationsEnabled => 'Enabled';

  @override
  String get notificationsDisabled => 'Disabled';

  @override
  String get privacyTitle => 'Privacy & Data';

  @override
  String get privacySubtitle => 'Local data & telemetry control';

  @override
  String get encryptionLabel => 'Local Data Encryption';

  @override
  String get analyticsLabel => 'Analytics Opt-Out';

  @override
  String get deleteAllDataAction => 'Delete All Local Data';

  @override
  String get deleteAllDataTitle => 'Delete All Local Data';

  @override
  String get deleteAllDataMessage =>
      'Are you sure you want to clear all stored commitments and activity history? This cannot be undone.';

  @override
  String get dataClearedMessage => 'All local data cleared.';

  @override
  String get languageTitle => 'Language';

  @override
  String get languageSubtitle => 'Application copy & directionality';

  @override
  String get languageSystem => 'System default';

  @override
  String get languageEnglish => 'English';

  @override
  String get languageArabic => 'العربية';

  @override
  String get languageHebrew => 'עברית';

  @override
  String get activityTitle => 'Activity History';

  @override
  String get activitySubtitle => 'Timeline log of AI extractions & updates';

  @override
  String get emptyActivityTitle => 'No Activity Yet';

  @override
  String get emptyActivityDescription =>
      'Actions, commitments, and AI processing logs will appear here.';

  @override
  String get welcomeTitle => 'Welcome to Maybesitter';

  @override
  String get welcomeSubtitle =>
      'Quiet Intelligence for your daily commitments and flexible plans.';

  @override
  String get getStartedAction => 'Get Started';

  @override
  String get skipAction => 'Skip';

  @override
  String get cancelAction => 'Cancel';

  @override
  String get saveAction => 'Save';

  @override
  String get retryAction => 'Try Again';

  @override
  String get backAction => 'Back';

  @override
  String get closeAction => 'Close';

  @override
  String get offlineBannerText => 'Offline — Changes will sync locally';

  @override
  String get noCommitmentsTodayTitle => 'No Commitments Today';

  @override
  String get noCommitmentsTodayDesc =>
      'You have a clean slate! Tap below to capture a new plan.';

  @override
  String get noUpcomingCommitmentsTitle => 'No Upcoming Commitments';

  @override
  String get noUpcomingCommitmentsDesc =>
      'No plans scheduled for the selected filter.';

  @override
  String get capturePlanAction => 'Capture Plan';

  @override
  String get processingLabel =>
      'Analyzing your plan with Quiet Intelligence...';

  @override
  String get nowGroupHeader => 'Now • MUST';

  @override
  String get laterTodayGroupHeader => 'Later today • SHOULD';

  @override
  String get optionalGroupHeader => 'Optional • NICE';

  @override
  String get completedGroupHeader => 'Completed';

  @override
  String get tomorrowGroupHeader => 'Tomorrow';

  @override
  String get thisWeekGroupHeader => 'This week';

  @override
  String get laterGroupHeader => 'Later';

  @override
  String get agendaView => 'Agenda';

  @override
  String get compactCalendarView => 'Compact Calendar';

  @override
  String itemsCountLabel(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count items',
      one: '1 item',
    );
    return '$_temp0';
  }

  @override
  String doneCountLabel(int count) {
    return '$count done';
  }

  @override
  String get unsupportedRequestTitle => 'Unsupported Request';

  @override
  String get unsupportedRequestMessage =>
      'The request could not be processed as a commitment or plan.';

  @override
  String get networkErrorMessage =>
      'Unable to connect to the backend server. Please check your connection.';

  @override
  String get proposalExpiredMessage =>
      'The proposal has expired. Please analyze your plan again.';

  @override
  String get validationErrorMessage =>
      'Server validation error. Please review your input.';

  @override
  String get confirmFailedMessage =>
      'Failed to confirm proposal on the server.';

  @override
  String get noDateGroupHeader => 'No date set';

  @override
  String get overdueGroupHeader => 'Overdue';

  @override
  String get reminderHistoryTitle => 'Reminder History';

  @override
  String get reminderHistorySubtitle => 'Log of notification delivery attempts';
}
