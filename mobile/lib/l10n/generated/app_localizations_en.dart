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
  String get moreActionsLabel => 'More actions';

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

  @override
  String get nextStepSectionTitle => 'Your next step';

  @override
  String get nextStepProposalNotice =>
      'A suggestion. Nothing has been changed yet.';

  @override
  String get nextStepWhyTitle => 'Why this one';

  @override
  String get nextStepNoSensitiveInference =>
      'No sensitive guesses were used to pick this.';

  @override
  String get nextStepActionAccept => 'Accept';

  @override
  String get nextStepActionEdit => 'Edit';

  @override
  String get nextStepActionDefer => 'Not now';

  @override
  String get nextStepActionDismiss => 'Dismiss';

  @override
  String get nextStepActionDone => 'Already done';

  @override
  String get nextStepAcceptedMessage => 'Accepted. Start it whenever you want.';

  @override
  String get nextStepEditedMessage => 'Updated.';

  @override
  String get nextStepDeferredMessage => 'Set aside for now.';

  @override
  String get nextStepDismissedMessage => 'Dismissed.';

  @override
  String get nextStepDoneMessage => 'Marked as already done.';

  @override
  String get nextStepShowAnotherAction => 'Show another';

  @override
  String get nextStepEmptyTitle => 'Nothing to suggest right now';

  @override
  String get nextStepEmptyMessage =>
      'Capture something and confirm it, and a next step will show up here.';

  @override
  String get nextStepInsufficientTitle => 'Not enough to go on yet';

  @override
  String get nextStepInsufficientMessage =>
      'Confirm a few more commitments and a suggestion will appear.';

  @override
  String get nextStepStaleMessage =>
      'That suggestion changed while you were deciding. Here is the current one.';

  @override
  String get nextStepLoadingLabel => 'Finding your next step';

  @override
  String get nextStepFailedTitle => 'Couldn\'t load a suggestion';

  @override
  String get nextStepEditTitle => 'Edit this step';

  @override
  String get nextStepEditFieldLabel => 'Next step';

  @override
  String get nextStepEditHelp => 'Word it the way you would actually do it.';

  @override
  String get evidenceDueToday => 'Due today';

  @override
  String get evidenceOverdue => 'Past its date';

  @override
  String get evidenceConfirmedByYou => 'You confirmed it';

  @override
  String get evidenceHighPriority => 'You marked it a must';

  @override
  String get evidenceScheduledSoon => 'Coming up soon';

  @override
  String get evidenceOnlyOpenItem => 'It\'s your only open item';

  @override
  String get evidenceOther => 'Based on commitments you confirmed';

  @override
  String get pilotStateUnauthorizedTitle => 'This device isn\'t in the pilot';

  @override
  String get pilotStateUnauthorizedMessage =>
      'The pilot code on this device isn\'t on the participant list, so suggestions are off. If that seems wrong, contact whoever invited you.';

  @override
  String get pilotStateWrongInstanceTitle => 'Wrong pilot device';

  @override
  String get pilotStateWrongInstanceMessage =>
      'This copy of the app is set up for a different participant. Use the link you were sent.';

  @override
  String get pilotStateSuspendedTitle => 'Your pilot access is paused';

  @override
  String get pilotStateSuspendedMessage =>
      'Someone running the pilot paused your access. Your commitments are safe and nothing has been deleted.';

  @override
  String get pilotStatePausedTitle => 'Suggestions are paused';

  @override
  String get pilotStatePausedMessage =>
      'Suggestions are paused for everyone in the pilot right now. Capture still works and nothing has been lost.';

  @override
  String get pilotStateDisabledTitle => 'Suggestions are off';

  @override
  String get pilotStateDisabledMessage =>
      'This build has suggestions switched off. Capture and your commitments work as usual.';

  @override
  String get pilotStateConsentRequiredTitle => 'Want a suggested next step?';

  @override
  String get pilotStateConsentRequiredMessage =>
      'MaybeSitter can propose one next step from commitments you\'ve already confirmed. It never changes anything on its own, and you can switch this off at any time.';

  @override
  String get pilotStateConsentRequiredAction => 'Turn on suggestions';

  @override
  String get pilotStateQuietTitle => 'Quiet mode is on';

  @override
  String get pilotStateQuietMessage =>
      'Suggestions stay hidden until you turn quiet mode off. Nothing has been deleted.';

  @override
  String get pilotStateQuietAction => 'Turn off quiet mode';

  @override
  String get pilotStateRevokedTitle => 'You turned suggestions off';

  @override
  String get pilotStateRevokedMessage =>
      'Your commitments are still here. You can turn suggestions back on whenever you like.';

  @override
  String get pilotStateRevokedAction => 'Turn suggestions back on';

  @override
  String get pilotStateDeletedTitle => 'Your pilot data was deleted';

  @override
  String get pilotStateDeletedMessage =>
      'Nothing is stored for you any more. Thanks for taking part.';

  @override
  String get pilotStateUnknownTitle => 'Suggestions are unavailable';

  @override
  String get pilotStateUnknownMessage =>
      'MaybeSitter can\'t confirm your pilot status, so it isn\'t showing a suggestion. Capture still works.';

  @override
  String get pilotStateOfflineTitle => 'Can\'t reach MaybeSitter';

  @override
  String get pilotStateOfflineMessage =>
      'Your commitments are safe on this device. Try again in a moment.';

  @override
  String get trustCenterTitle => 'Trust & privacy';

  @override
  String get trustCenterSubtitle =>
      'What\'s on, what\'s off, and how to change it';

  @override
  String get trustSectionControls => 'Your controls';

  @override
  String get trustSectionEnding => 'Stopping';

  @override
  String get trustRecommendationConsentLabel => 'Suggestions';

  @override
  String get trustRecommendationConsentDescription =>
      'Let MaybeSitter propose one next step. It only ever proposes.';

  @override
  String get trustAnalyticsConsentLabel => 'Share usage data';

  @override
  String get trustAnalyticsConsentDescription =>
      'Counts only, never your text. The app works the same either way.';

  @override
  String get trustQuietModeLabel => 'Quiet mode';

  @override
  String get trustQuietModeDescription =>
      'Hide suggestions without losing anything.';

  @override
  String get trustCalendarConsentLabel => 'Connect your calendar';

  @override
  String get trustCalendarConsentDescription =>
      'Optional and read-only. Disconnect whenever you want.';

  @override
  String get trustCalendarLockedTitle => 'Calendar comes later';

  @override
  String get trustCalendarLockedMessage =>
      'MaybeSitter will offer to connect your calendar once it has actually been useful to you. It won\'t ask before then.';

  @override
  String get trustWhatWeKnowAction => 'What MaybeSitter knows';

  @override
  String get trustWhatWeKnowSubtitle => 'See everything it holds about you';

  @override
  String get trustRevokeTitle => 'Turn everything off';

  @override
  String get trustRevokeDescription =>
      'Switches off suggestions, usage data and calendar. Your commitments stay.';

  @override
  String get trustRevokeConfirmTitle => 'Turn everything off?';

  @override
  String get trustRevokeConfirmMessage =>
      'Suggestions, usage data and any calendar connection get switched off. Your commitments stay, and you can turn things back on later.';

  @override
  String get trustRevokedMessage => 'Everything is switched off.';

  @override
  String get trustDeleteTitle => 'Delete everything';

  @override
  String get trustDeleteDescription =>
      'Removes your commitments and usage data. This can\'t be undone.';

  @override
  String get trustDeleteConfirmTitle => 'Delete everything?';

  @override
  String get trustDeleteConfirmMessage =>
      'This permanently removes your commitments and your usage data.';

  @override
  String get trustDeleteAcknowledge => 'I understand this can\'t be undone';

  @override
  String get trustDeletedMessage => 'Your data has been deleted.';

  @override
  String get trustUpdatedMessage => 'Saved.';

  @override
  String get trustLoadFailedTitle => 'Couldn\'t load your privacy settings';

  @override
  String get trustActionFailedMessage => 'That didn\'t save. Try again.';

  @override
  String get knowsTitle => 'What MaybeSitter knows';

  @override
  String get knowsSubtitle => 'Everything it holds about you, in one list';

  @override
  String get knowsCommitmentsLabel => 'Commitments you confirmed';

  @override
  String knowsCommitmentsCount(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count commitments',
      one: '1 commitment',
      zero: 'None',
    );
    return '$_temp0';
  }

  @override
  String get knowsRecommendationLabel => 'Suggestions';

  @override
  String get knowsAnalyticsLabel => 'Usage data';

  @override
  String get knowsCalendarLabel => 'Calendar';

  @override
  String get knowsOn => 'On';

  @override
  String get knowsOff => 'Off';

  @override
  String get knowsConnected => 'Connected';

  @override
  String get knowsNotConnected => 'Not connected';

  @override
  String get knowsNeverSectionTitle => 'Never collected';

  @override
  String get knowsNoMessages => 'Your private messages';

  @override
  String get knowsNoSensitive =>
      'Guesses about your health, mood or relationships';

  @override
  String get knowsNoMedical => 'Any medical or diagnostic profile';

  @override
  String get knowsParticipantLabel => 'Your pilot code';

  @override
  String get knowsParticipantNote =>
      'A random code. It isn\'t your name and nothing here links it to one.';

  @override
  String get pilotAccessTitle => 'Pilot access';

  @override
  String get pilotAccessMessage =>
      'Enter the token you were issued to use this pilot build.';

  @override
  String get pilotAccessTokenLabel => 'Pilot token';

  @override
  String get pilotAccessContinue => 'Continue';

  @override
  String get pilotAccessValidating => 'Checking access';

  @override
  String get pilotAccessInvalidTitle => 'That token did not work';

  @override
  String get pilotAccessInvalidMessage =>
      'Check the token you were issued and try again.';

  @override
  String get pilotAccessNotAllowlistedTitle => 'This token is not in the pilot';

  @override
  String get pilotAccessNotAllowlistedMessage =>
      'MaybeSitter could not admit this token to the current pilot.';

  @override
  String get pilotAccessRevokedTitle => 'Pilot access was revoked';

  @override
  String get pilotAccessRevokedMessage =>
      'This pilot session is closed. Your normal app screens are no longer available for this token.';

  @override
  String get pilotAccessDeletedTitle => 'Pilot data was deleted';

  @override
  String get pilotAccessDeletedMessage =>
      'The pilot data for this token has been deleted. The app will stay closed for this session.';

  @override
  String get pilotAccessBackendUnavailableTitle => 'Cannot reach MaybeSitter';

  @override
  String get pilotAccessBackendUnavailableMessage =>
      'Keep the token on this device and try again when the backend is available.';

  @override
  String get pilotAccessRuntimeConfigTitle => 'Pilot is not configured';

  @override
  String get pilotAccessRuntimeConfigMessage =>
      'The pilot backend is failing closed because its runtime configuration is invalid.';

  @override
  String get pilotAccessClearToken => 'Use a different token';

  @override
  String get alphaFlagTooltip => 'Report a problem';

  @override
  String get alphaFlagTitle => 'Report a problem with this step';

  @override
  String get alphaFlagCategoryWrong => 'This recommendation is wrong';

  @override
  String get alphaFlagCategoryMisunderstood => 'It misunderstood me';

  @override
  String get alphaFlagCategoryNotUseful => 'It was not useful';

  @override
  String get alphaFlagCategoryInvasive => 'It felt invasive';

  @override
  String get alphaFlagCategoryTechnical => 'Technical problem';

  @override
  String get alphaFlagNoteHint => 'Optional details';

  @override
  String get alphaFlagPickCategory => 'Please choose a category';

  @override
  String get alphaFlagSubmit => 'Send report';

  @override
  String get alphaFlagSent => 'Thank you — report received.';

  @override
  String get alphaFlagDisabled => 'Reporting is not enabled in this build.';
}
