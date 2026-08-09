import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_ar.dart';
import 'app_localizations_en.dart';
import 'app_localizations_he.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'generated/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations? of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations);
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('ar'),
    Locale('en'),
    Locale('he'),
  ];

  /// The product application name
  ///
  /// In en, this message translates to:
  /// **'Maybesitter'**
  String get appName;

  /// No description provided for @todayTab.
  ///
  /// In en, this message translates to:
  /// **'Today'**
  String get todayTab;

  /// No description provided for @upcomingTab.
  ///
  /// In en, this message translates to:
  /// **'Upcoming'**
  String get upcomingTab;

  /// No description provided for @activityTab.
  ///
  /// In en, this message translates to:
  /// **'Activity'**
  String get activityTab;

  /// No description provided for @settingsTab.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get settingsTab;

  /// No description provided for @goodMorningUser.
  ///
  /// In en, this message translates to:
  /// **'Good morning, {userName}'**
  String goodMorningUser(String userName);

  /// No description provided for @commitmentsCountToday.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =0{No active commitments today} =1{1 commitment remaining for today} other{{count} commitments remaining for today}}'**
  String commitmentsCountToday(int count);

  /// No description provided for @priorityMust.
  ///
  /// In en, this message translates to:
  /// **'MUST'**
  String get priorityMust;

  /// No description provided for @priorityShould.
  ///
  /// In en, this message translates to:
  /// **'SHOULD'**
  String get priorityShould;

  /// No description provided for @priorityNice.
  ///
  /// In en, this message translates to:
  /// **'NICE'**
  String get priorityNice;

  /// No description provided for @priorityFilterAll.
  ///
  /// In en, this message translates to:
  /// **'All'**
  String get priorityFilterAll;

  /// No description provided for @statusPending.
  ///
  /// In en, this message translates to:
  /// **'Pending'**
  String get statusPending;

  /// No description provided for @statusCompleted.
  ///
  /// In en, this message translates to:
  /// **'Completed'**
  String get statusCompleted;

  /// No description provided for @statusPostponed.
  ///
  /// In en, this message translates to:
  /// **'Postponed'**
  String get statusPostponed;

  /// No description provided for @statusCancelled.
  ///
  /// In en, this message translates to:
  /// **'Cancelled'**
  String get statusCancelled;

  /// No description provided for @statusUnknown.
  ///
  /// In en, this message translates to:
  /// **'Unknown'**
  String get statusUnknown;

  /// No description provided for @newIntentTitle.
  ///
  /// In en, this message translates to:
  /// **'New Intent'**
  String get newIntentTitle;

  /// No description provided for @captureHintText.
  ///
  /// In en, this message translates to:
  /// **'Type or speak freely. Maybesitter extracts commitments, times, and priorities automatically.'**
  String get captureHintText;

  /// No description provided for @composerInputHint.
  ///
  /// In en, this message translates to:
  /// **'e.g. \"Tomorrow morning at 9am doctor visit, then meet Sarah for coffee at 2pm...\"'**
  String get composerInputHint;

  /// No description provided for @voiceCaptureTooltip.
  ///
  /// In en, this message translates to:
  /// **'Voice Capture'**
  String get voiceCaptureTooltip;

  /// No description provided for @voiceCaptureStopTooltip.
  ///
  /// In en, this message translates to:
  /// **'Stop Recording'**
  String get voiceCaptureStopTooltip;

  /// No description provided for @editingDisabledExplanation.
  ///
  /// In en, this message translates to:
  /// **'Editing is temporarily unavailable to protect your scheduled time.'**
  String get editingDisabledExplanation;

  /// No description provided for @privacyNote.
  ///
  /// In en, this message translates to:
  /// **'Your plan is analyzed privately with Quiet Intelligence.'**
  String get privacyNote;

  /// No description provided for @analyzeAction.
  ///
  /// In en, this message translates to:
  /// **'Analyze'**
  String get analyzeAction;

  /// No description provided for @reviewPlanTitle.
  ///
  /// In en, this message translates to:
  /// **'Review Your Plan'**
  String get reviewPlanTitle;

  /// No description provided for @proposedCommitmentsCount.
  ///
  /// In en, this message translates to:
  /// **'Proposed Commitments ({count})'**
  String proposedCommitmentsCount(int count);

  /// No description provided for @confirmCommitmentsAction.
  ///
  /// In en, this message translates to:
  /// **'Confirm {count, plural, =1{1 Commitment} other{{count} Commitments}}'**
  String confirmCommitmentsAction(int count);

  /// No description provided for @cancelPlanAction.
  ///
  /// In en, this message translates to:
  /// **'Cancel Entire Plan'**
  String get cancelPlanAction;

  /// No description provided for @editCommitmentTitle.
  ///
  /// In en, this message translates to:
  /// **'Edit Commitment'**
  String get editCommitmentTitle;

  /// No description provided for @clarificationTitle.
  ///
  /// In en, this message translates to:
  /// **'Clarification'**
  String get clarificationTitle;

  /// No description provided for @clarificationCardHeader.
  ///
  /// In en, this message translates to:
  /// **'Clarification Needed'**
  String get clarificationCardHeader;

  /// No description provided for @noCommitmentTitle.
  ///
  /// In en, this message translates to:
  /// **'Nothing Found'**
  String get noCommitmentTitle;

  /// No description provided for @noCommitmentDescription.
  ///
  /// In en, this message translates to:
  /// **'I understood the message, but I could not find a plan or actionable commitment to save.'**
  String get noCommitmentDescription;

  /// No description provided for @extractionErrorTitle.
  ///
  /// In en, this message translates to:
  /// **'Extraction Error'**
  String get extractionErrorTitle;

  /// No description provided for @extractionErrorMessage.
  ///
  /// In en, this message translates to:
  /// **'The AI was unable to parse your plan. Please try again.'**
  String get extractionErrorMessage;

  /// No description provided for @commitmentsAddedSuccess.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{Added 1 commitment for {date}.} other{Added {count} commitments for {date}.}}'**
  String commitmentsAddedSuccess(int count, String date);

  /// No description provided for @quietIntelligenceSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Your schedule has been updated with Quiet Intelligence.'**
  String get quietIntelligenceSubtitle;

  /// No description provided for @viewTomorrowAction.
  ///
  /// In en, this message translates to:
  /// **'View Tomorrow'**
  String get viewTomorrowAction;

  /// No description provided for @doneAction.
  ///
  /// In en, this message translates to:
  /// **'Done'**
  String get doneAction;

  /// No description provided for @undoAction.
  ///
  /// In en, this message translates to:
  /// **'Undo'**
  String get undoAction;

  /// No description provided for @undoSuccessMessage.
  ///
  /// In en, this message translates to:
  /// **'Saved commitments undone.'**
  String get undoSuccessMessage;

  /// No description provided for @commitmentDetailTitle.
  ///
  /// In en, this message translates to:
  /// **'Commitment Detail'**
  String get commitmentDetailTitle;

  /// No description provided for @scheduledDateLabel.
  ///
  /// In en, this message translates to:
  /// **'Scheduled Date'**
  String get scheduledDateLabel;

  /// No description provided for @timeLabel.
  ///
  /// In en, this message translates to:
  /// **'Time'**
  String get timeLabel;

  /// No description provided for @locationLabel.
  ///
  /// In en, this message translates to:
  /// **'Location'**
  String get locationLabel;

  /// No description provided for @categoryLabel.
  ///
  /// In en, this message translates to:
  /// **'Category'**
  String get categoryLabel;

  /// No description provided for @markCompleteAction.
  ///
  /// In en, this message translates to:
  /// **'Mark as Complete'**
  String get markCompleteAction;

  /// No description provided for @moreActionsLabel.
  ///
  /// In en, this message translates to:
  /// **'More actions'**
  String get moreActionsLabel;

  /// No description provided for @markPendingAction.
  ///
  /// In en, this message translates to:
  /// **'Mark as Pending'**
  String get markPendingAction;

  /// No description provided for @postponeAction.
  ///
  /// In en, this message translates to:
  /// **'Postpone Commitment'**
  String get postponeAction;

  /// No description provided for @deleteAction.
  ///
  /// In en, this message translates to:
  /// **'Delete'**
  String get deleteAction;

  /// No description provided for @deleteConfirmationTitle.
  ///
  /// In en, this message translates to:
  /// **'Delete Commitment'**
  String get deleteConfirmationTitle;

  /// No description provided for @deleteConfirmationMessage.
  ///
  /// In en, this message translates to:
  /// **'Are you sure you want to delete \"{title}\"? This cannot be undone.'**
  String deleteConfirmationMessage(String title);

  /// No description provided for @postponeSheetTitle.
  ///
  /// In en, this message translates to:
  /// **'Postpone Commitment'**
  String get postponeSheetTitle;

  /// No description provided for @postponeOneHour.
  ///
  /// In en, this message translates to:
  /// **'1 Hour Later'**
  String get postponeOneHour;

  /// No description provided for @postponeThreeHours.
  ///
  /// In en, this message translates to:
  /// **'3 Hours Later'**
  String get postponeThreeHours;

  /// No description provided for @postponeTomorrowMorning.
  ///
  /// In en, this message translates to:
  /// **'Tomorrow Morning'**
  String get postponeTomorrowMorning;

  /// No description provided for @postponeNextWeek.
  ///
  /// In en, this message translates to:
  /// **'Next Week'**
  String get postponeNextWeek;

  /// No description provided for @settingsTitle.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get settingsTitle;

  /// No description provided for @settingsSubtitle.
  ///
  /// In en, this message translates to:
  /// **'App preferences & account'**
  String get settingsSubtitle;

  /// No description provided for @appearanceTitle.
  ///
  /// In en, this message translates to:
  /// **'Appearance'**
  String get appearanceTitle;

  /// No description provided for @appearanceSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Theme preferences'**
  String get appearanceSubtitle;

  /// No description provided for @themeModeLabel.
  ///
  /// In en, this message translates to:
  /// **'Theme Mode'**
  String get themeModeLabel;

  /// No description provided for @themeSystem.
  ///
  /// In en, this message translates to:
  /// **'System'**
  String get themeSystem;

  /// No description provided for @themeLight.
  ///
  /// In en, this message translates to:
  /// **'Light'**
  String get themeLight;

  /// No description provided for @themeDark.
  ///
  /// In en, this message translates to:
  /// **'Dark'**
  String get themeDark;

  /// No description provided for @notificationsTitle.
  ///
  /// In en, this message translates to:
  /// **'Notifications'**
  String get notificationsTitle;

  /// No description provided for @notificationsSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Reminders & quiet updates'**
  String get notificationsSubtitle;

  /// No description provided for @notificationsEnabled.
  ///
  /// In en, this message translates to:
  /// **'Enabled'**
  String get notificationsEnabled;

  /// No description provided for @notificationsDisabled.
  ///
  /// In en, this message translates to:
  /// **'Disabled'**
  String get notificationsDisabled;

  /// No description provided for @privacyTitle.
  ///
  /// In en, this message translates to:
  /// **'Privacy & Data'**
  String get privacyTitle;

  /// No description provided for @privacySubtitle.
  ///
  /// In en, this message translates to:
  /// **'Local data & telemetry control'**
  String get privacySubtitle;

  /// No description provided for @encryptionLabel.
  ///
  /// In en, this message translates to:
  /// **'Local Data Encryption'**
  String get encryptionLabel;

  /// No description provided for @analyticsLabel.
  ///
  /// In en, this message translates to:
  /// **'Analytics Opt-Out'**
  String get analyticsLabel;

  /// No description provided for @deleteAllDataAction.
  ///
  /// In en, this message translates to:
  /// **'Delete All Local Data'**
  String get deleteAllDataAction;

  /// No description provided for @deleteAllDataTitle.
  ///
  /// In en, this message translates to:
  /// **'Delete All Local Data'**
  String get deleteAllDataTitle;

  /// No description provided for @deleteAllDataMessage.
  ///
  /// In en, this message translates to:
  /// **'Are you sure you want to clear all stored commitments and activity history? This cannot be undone.'**
  String get deleteAllDataMessage;

  /// No description provided for @dataClearedMessage.
  ///
  /// In en, this message translates to:
  /// **'All local data cleared.'**
  String get dataClearedMessage;

  /// No description provided for @languageTitle.
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get languageTitle;

  /// No description provided for @languageSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Application copy & directionality'**
  String get languageSubtitle;

  /// No description provided for @languageSystem.
  ///
  /// In en, this message translates to:
  /// **'System default'**
  String get languageSystem;

  /// No description provided for @languageEnglish.
  ///
  /// In en, this message translates to:
  /// **'English'**
  String get languageEnglish;

  /// No description provided for @languageArabic.
  ///
  /// In en, this message translates to:
  /// **'العربية'**
  String get languageArabic;

  /// No description provided for @languageHebrew.
  ///
  /// In en, this message translates to:
  /// **'עברית'**
  String get languageHebrew;

  /// No description provided for @activityTitle.
  ///
  /// In en, this message translates to:
  /// **'Activity History'**
  String get activityTitle;

  /// No description provided for @activitySubtitle.
  ///
  /// In en, this message translates to:
  /// **'Timeline log of AI extractions & updates'**
  String get activitySubtitle;

  /// No description provided for @emptyActivityTitle.
  ///
  /// In en, this message translates to:
  /// **'No Activity Yet'**
  String get emptyActivityTitle;

  /// No description provided for @emptyActivityDescription.
  ///
  /// In en, this message translates to:
  /// **'Actions, commitments, and AI processing logs will appear here.'**
  String get emptyActivityDescription;

  /// No description provided for @welcomeTitle.
  ///
  /// In en, this message translates to:
  /// **'Welcome to Maybesitter'**
  String get welcomeTitle;

  /// No description provided for @welcomeSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Quiet Intelligence for your daily commitments and flexible plans.'**
  String get welcomeSubtitle;

  /// No description provided for @getStartedAction.
  ///
  /// In en, this message translates to:
  /// **'Get Started'**
  String get getStartedAction;

  /// No description provided for @skipAction.
  ///
  /// In en, this message translates to:
  /// **'Skip'**
  String get skipAction;

  /// No description provided for @cancelAction.
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get cancelAction;

  /// No description provided for @saveAction.
  ///
  /// In en, this message translates to:
  /// **'Save'**
  String get saveAction;

  /// No description provided for @retryAction.
  ///
  /// In en, this message translates to:
  /// **'Try Again'**
  String get retryAction;

  /// No description provided for @backAction.
  ///
  /// In en, this message translates to:
  /// **'Back'**
  String get backAction;

  /// No description provided for @closeAction.
  ///
  /// In en, this message translates to:
  /// **'Close'**
  String get closeAction;

  /// No description provided for @offlineBannerText.
  ///
  /// In en, this message translates to:
  /// **'Offline — Changes will sync locally'**
  String get offlineBannerText;

  /// No description provided for @noCommitmentsTodayTitle.
  ///
  /// In en, this message translates to:
  /// **'No Commitments Today'**
  String get noCommitmentsTodayTitle;

  /// No description provided for @noCommitmentsTodayDesc.
  ///
  /// In en, this message translates to:
  /// **'You have a clean slate! Tap below to capture a new plan.'**
  String get noCommitmentsTodayDesc;

  /// No description provided for @noUpcomingCommitmentsTitle.
  ///
  /// In en, this message translates to:
  /// **'No Upcoming Commitments'**
  String get noUpcomingCommitmentsTitle;

  /// No description provided for @noUpcomingCommitmentsDesc.
  ///
  /// In en, this message translates to:
  /// **'No plans scheduled for the selected filter.'**
  String get noUpcomingCommitmentsDesc;

  /// No description provided for @capturePlanAction.
  ///
  /// In en, this message translates to:
  /// **'Capture Plan'**
  String get capturePlanAction;

  /// No description provided for @processingLabel.
  ///
  /// In en, this message translates to:
  /// **'Analyzing your plan with Quiet Intelligence...'**
  String get processingLabel;

  /// No description provided for @nowGroupHeader.
  ///
  /// In en, this message translates to:
  /// **'Now • MUST'**
  String get nowGroupHeader;

  /// No description provided for @laterTodayGroupHeader.
  ///
  /// In en, this message translates to:
  /// **'Later today • SHOULD'**
  String get laterTodayGroupHeader;

  /// No description provided for @optionalGroupHeader.
  ///
  /// In en, this message translates to:
  /// **'Optional • NICE'**
  String get optionalGroupHeader;

  /// No description provided for @completedGroupHeader.
  ///
  /// In en, this message translates to:
  /// **'Completed'**
  String get completedGroupHeader;

  /// No description provided for @tomorrowGroupHeader.
  ///
  /// In en, this message translates to:
  /// **'Tomorrow'**
  String get tomorrowGroupHeader;

  /// No description provided for @thisWeekGroupHeader.
  ///
  /// In en, this message translates to:
  /// **'This week'**
  String get thisWeekGroupHeader;

  /// No description provided for @laterGroupHeader.
  ///
  /// In en, this message translates to:
  /// **'Later'**
  String get laterGroupHeader;

  /// No description provided for @agendaView.
  ///
  /// In en, this message translates to:
  /// **'Agenda'**
  String get agendaView;

  /// No description provided for @compactCalendarView.
  ///
  /// In en, this message translates to:
  /// **'Compact Calendar'**
  String get compactCalendarView;

  /// No description provided for @itemsCountLabel.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 item} other{{count} items}}'**
  String itemsCountLabel(int count);

  /// No description provided for @doneCountLabel.
  ///
  /// In en, this message translates to:
  /// **'{count} done'**
  String doneCountLabel(int count);

  /// No description provided for @unsupportedRequestTitle.
  ///
  /// In en, this message translates to:
  /// **'Unsupported Request'**
  String get unsupportedRequestTitle;

  /// No description provided for @unsupportedRequestMessage.
  ///
  /// In en, this message translates to:
  /// **'The request could not be processed as a commitment or plan.'**
  String get unsupportedRequestMessage;

  /// No description provided for @networkErrorMessage.
  ///
  /// In en, this message translates to:
  /// **'Unable to connect to the backend server. Please check your connection.'**
  String get networkErrorMessage;

  /// No description provided for @proposalExpiredMessage.
  ///
  /// In en, this message translates to:
  /// **'The proposal has expired. Please analyze your plan again.'**
  String get proposalExpiredMessage;

  /// No description provided for @validationErrorMessage.
  ///
  /// In en, this message translates to:
  /// **'Server validation error. Please review your input.'**
  String get validationErrorMessage;

  /// No description provided for @confirmFailedMessage.
  ///
  /// In en, this message translates to:
  /// **'Failed to confirm proposal on the server.'**
  String get confirmFailedMessage;

  /// No description provided for @noDateGroupHeader.
  ///
  /// In en, this message translates to:
  /// **'No date set'**
  String get noDateGroupHeader;

  /// No description provided for @overdueGroupHeader.
  ///
  /// In en, this message translates to:
  /// **'Overdue'**
  String get overdueGroupHeader;

  /// No description provided for @reminderHistoryTitle.
  ///
  /// In en, this message translates to:
  /// **'Reminder History'**
  String get reminderHistoryTitle;

  /// No description provided for @reminderHistorySubtitle.
  ///
  /// In en, this message translates to:
  /// **'Log of notification delivery attempts'**
  String get reminderHistorySubtitle;

  /// No description provided for @nextStepSectionTitle.
  ///
  /// In en, this message translates to:
  /// **'Your next step'**
  String get nextStepSectionTitle;

  /// No description provided for @nextStepProposalNotice.
  ///
  /// In en, this message translates to:
  /// **'A suggestion. Nothing has been changed yet.'**
  String get nextStepProposalNotice;

  /// No description provided for @nextStepWhyTitle.
  ///
  /// In en, this message translates to:
  /// **'Why this one'**
  String get nextStepWhyTitle;

  /// No description provided for @nextStepNoSensitiveInference.
  ///
  /// In en, this message translates to:
  /// **'No sensitive guesses were used to pick this.'**
  String get nextStepNoSensitiveInference;

  /// No description provided for @nextStepActionAccept.
  ///
  /// In en, this message translates to:
  /// **'Accept'**
  String get nextStepActionAccept;

  /// No description provided for @nextStepActionEdit.
  ///
  /// In en, this message translates to:
  /// **'Edit'**
  String get nextStepActionEdit;

  /// No description provided for @nextStepActionDefer.
  ///
  /// In en, this message translates to:
  /// **'Not now'**
  String get nextStepActionDefer;

  /// No description provided for @nextStepActionDismiss.
  ///
  /// In en, this message translates to:
  /// **'Dismiss'**
  String get nextStepActionDismiss;

  /// No description provided for @nextStepActionDone.
  ///
  /// In en, this message translates to:
  /// **'Already done'**
  String get nextStepActionDone;

  /// No description provided for @nextStepAcceptedMessage.
  ///
  /// In en, this message translates to:
  /// **'Accepted. Start it whenever you want.'**
  String get nextStepAcceptedMessage;

  /// No description provided for @nextStepEditedMessage.
  ///
  /// In en, this message translates to:
  /// **'Updated.'**
  String get nextStepEditedMessage;

  /// No description provided for @nextStepDeferredMessage.
  ///
  /// In en, this message translates to:
  /// **'Set aside for now.'**
  String get nextStepDeferredMessage;

  /// No description provided for @nextStepDismissedMessage.
  ///
  /// In en, this message translates to:
  /// **'Dismissed.'**
  String get nextStepDismissedMessage;

  /// No description provided for @nextStepDoneMessage.
  ///
  /// In en, this message translates to:
  /// **'Marked as already done.'**
  String get nextStepDoneMessage;

  /// No description provided for @nextStepShowAnotherAction.
  ///
  /// In en, this message translates to:
  /// **'Show another'**
  String get nextStepShowAnotherAction;

  /// No description provided for @nextStepEmptyTitle.
  ///
  /// In en, this message translates to:
  /// **'Nothing to suggest right now'**
  String get nextStepEmptyTitle;

  /// No description provided for @nextStepEmptyMessage.
  ///
  /// In en, this message translates to:
  /// **'Capture something and confirm it, and a next step will show up here.'**
  String get nextStepEmptyMessage;

  /// No description provided for @nextStepInsufficientTitle.
  ///
  /// In en, this message translates to:
  /// **'Not enough to go on yet'**
  String get nextStepInsufficientTitle;

  /// No description provided for @nextStepInsufficientMessage.
  ///
  /// In en, this message translates to:
  /// **'Confirm a few more commitments and a suggestion will appear.'**
  String get nextStepInsufficientMessage;

  /// No description provided for @nextStepStaleMessage.
  ///
  /// In en, this message translates to:
  /// **'That suggestion changed while you were deciding. Here is the current one.'**
  String get nextStepStaleMessage;

  /// No description provided for @nextStepLoadingLabel.
  ///
  /// In en, this message translates to:
  /// **'Finding your next step'**
  String get nextStepLoadingLabel;

  /// No description provided for @nextStepFailedTitle.
  ///
  /// In en, this message translates to:
  /// **'Couldn\'t load a suggestion'**
  String get nextStepFailedTitle;

  /// No description provided for @nextStepEditTitle.
  ///
  /// In en, this message translates to:
  /// **'Edit this step'**
  String get nextStepEditTitle;

  /// No description provided for @nextStepEditFieldLabel.
  ///
  /// In en, this message translates to:
  /// **'Next step'**
  String get nextStepEditFieldLabel;

  /// No description provided for @nextStepEditHelp.
  ///
  /// In en, this message translates to:
  /// **'Word it the way you would actually do it.'**
  String get nextStepEditHelp;

  /// No description provided for @evidenceDueToday.
  ///
  /// In en, this message translates to:
  /// **'Due today'**
  String get evidenceDueToday;

  /// No description provided for @evidenceOverdue.
  ///
  /// In en, this message translates to:
  /// **'Past its date'**
  String get evidenceOverdue;

  /// No description provided for @evidenceConfirmedByYou.
  ///
  /// In en, this message translates to:
  /// **'You confirmed it'**
  String get evidenceConfirmedByYou;

  /// No description provided for @evidenceHighPriority.
  ///
  /// In en, this message translates to:
  /// **'You marked it a must'**
  String get evidenceHighPriority;

  /// No description provided for @evidenceScheduledSoon.
  ///
  /// In en, this message translates to:
  /// **'Coming up soon'**
  String get evidenceScheduledSoon;

  /// No description provided for @evidenceOnlyOpenItem.
  ///
  /// In en, this message translates to:
  /// **'It\'s your only open item'**
  String get evidenceOnlyOpenItem;

  /// No description provided for @evidenceOther.
  ///
  /// In en, this message translates to:
  /// **'Based on commitments you confirmed'**
  String get evidenceOther;

  /// No description provided for @pilotStateUnauthorizedTitle.
  ///
  /// In en, this message translates to:
  /// **'This device isn\'t in the pilot'**
  String get pilotStateUnauthorizedTitle;

  /// No description provided for @pilotStateUnauthorizedMessage.
  ///
  /// In en, this message translates to:
  /// **'The pilot code on this device isn\'t on the participant list, so suggestions are off. If that seems wrong, contact whoever invited you.'**
  String get pilotStateUnauthorizedMessage;

  /// No description provided for @pilotStateWrongInstanceTitle.
  ///
  /// In en, this message translates to:
  /// **'Wrong pilot device'**
  String get pilotStateWrongInstanceTitle;

  /// No description provided for @pilotStateWrongInstanceMessage.
  ///
  /// In en, this message translates to:
  /// **'This copy of the app is set up for a different participant. Use the link you were sent.'**
  String get pilotStateWrongInstanceMessage;

  /// No description provided for @pilotStateSuspendedTitle.
  ///
  /// In en, this message translates to:
  /// **'Your pilot access is paused'**
  String get pilotStateSuspendedTitle;

  /// No description provided for @pilotStateSuspendedMessage.
  ///
  /// In en, this message translates to:
  /// **'Someone running the pilot paused your access. Your commitments are safe and nothing has been deleted.'**
  String get pilotStateSuspendedMessage;

  /// No description provided for @pilotStatePausedTitle.
  ///
  /// In en, this message translates to:
  /// **'Suggestions are paused'**
  String get pilotStatePausedTitle;

  /// No description provided for @pilotStatePausedMessage.
  ///
  /// In en, this message translates to:
  /// **'Suggestions are paused for everyone in the pilot right now. Capture still works and nothing has been lost.'**
  String get pilotStatePausedMessage;

  /// No description provided for @pilotStateDisabledTitle.
  ///
  /// In en, this message translates to:
  /// **'Suggestions are off'**
  String get pilotStateDisabledTitle;

  /// No description provided for @pilotStateDisabledMessage.
  ///
  /// In en, this message translates to:
  /// **'This build has suggestions switched off. Capture and your commitments work as usual.'**
  String get pilotStateDisabledMessage;

  /// No description provided for @pilotStateConsentRequiredTitle.
  ///
  /// In en, this message translates to:
  /// **'Want a suggested next step?'**
  String get pilotStateConsentRequiredTitle;

  /// No description provided for @pilotStateConsentRequiredMessage.
  ///
  /// In en, this message translates to:
  /// **'MaybeSitter can propose one next step from commitments you\'ve already confirmed. It never changes anything on its own, and you can switch this off at any time.'**
  String get pilotStateConsentRequiredMessage;

  /// No description provided for @pilotStateConsentRequiredAction.
  ///
  /// In en, this message translates to:
  /// **'Turn on suggestions'**
  String get pilotStateConsentRequiredAction;

  /// No description provided for @pilotStateQuietTitle.
  ///
  /// In en, this message translates to:
  /// **'Quiet mode is on'**
  String get pilotStateQuietTitle;

  /// No description provided for @pilotStateQuietMessage.
  ///
  /// In en, this message translates to:
  /// **'Suggestions stay hidden until you turn quiet mode off. Nothing has been deleted.'**
  String get pilotStateQuietMessage;

  /// No description provided for @pilotStateQuietAction.
  ///
  /// In en, this message translates to:
  /// **'Turn off quiet mode'**
  String get pilotStateQuietAction;

  /// No description provided for @pilotStateRevokedTitle.
  ///
  /// In en, this message translates to:
  /// **'You turned suggestions off'**
  String get pilotStateRevokedTitle;

  /// No description provided for @pilotStateRevokedMessage.
  ///
  /// In en, this message translates to:
  /// **'Your commitments are still here. You can turn suggestions back on whenever you like.'**
  String get pilotStateRevokedMessage;

  /// No description provided for @pilotStateRevokedAction.
  ///
  /// In en, this message translates to:
  /// **'Turn suggestions back on'**
  String get pilotStateRevokedAction;

  /// No description provided for @pilotStateDeletedTitle.
  ///
  /// In en, this message translates to:
  /// **'Your pilot data was deleted'**
  String get pilotStateDeletedTitle;

  /// No description provided for @pilotStateDeletedMessage.
  ///
  /// In en, this message translates to:
  /// **'Nothing is stored for you any more. Thanks for taking part.'**
  String get pilotStateDeletedMessage;

  /// No description provided for @pilotStateUnknownTitle.
  ///
  /// In en, this message translates to:
  /// **'Suggestions are unavailable'**
  String get pilotStateUnknownTitle;

  /// No description provided for @pilotStateUnknownMessage.
  ///
  /// In en, this message translates to:
  /// **'MaybeSitter can\'t confirm your pilot status, so it isn\'t showing a suggestion. Capture still works.'**
  String get pilotStateUnknownMessage;

  /// No description provided for @pilotStateOfflineTitle.
  ///
  /// In en, this message translates to:
  /// **'Can\'t reach MaybeSitter'**
  String get pilotStateOfflineTitle;

  /// No description provided for @pilotStateOfflineMessage.
  ///
  /// In en, this message translates to:
  /// **'Your commitments are safe on this device. Try again in a moment.'**
  String get pilotStateOfflineMessage;

  /// No description provided for @trustCenterTitle.
  ///
  /// In en, this message translates to:
  /// **'Trust & privacy'**
  String get trustCenterTitle;

  /// No description provided for @trustCenterSubtitle.
  ///
  /// In en, this message translates to:
  /// **'What\'s on, what\'s off, and how to change it'**
  String get trustCenterSubtitle;

  /// No description provided for @trustSectionControls.
  ///
  /// In en, this message translates to:
  /// **'Your controls'**
  String get trustSectionControls;

  /// No description provided for @trustSectionEnding.
  ///
  /// In en, this message translates to:
  /// **'Stopping'**
  String get trustSectionEnding;

  /// No description provided for @trustRecommendationConsentLabel.
  ///
  /// In en, this message translates to:
  /// **'Suggestions'**
  String get trustRecommendationConsentLabel;

  /// No description provided for @trustRecommendationConsentDescription.
  ///
  /// In en, this message translates to:
  /// **'Let MaybeSitter propose one next step. It only ever proposes.'**
  String get trustRecommendationConsentDescription;

  /// No description provided for @trustAnalyticsConsentLabel.
  ///
  /// In en, this message translates to:
  /// **'Share usage data'**
  String get trustAnalyticsConsentLabel;

  /// No description provided for @trustAnalyticsConsentDescription.
  ///
  /// In en, this message translates to:
  /// **'Counts only, never your text. The app works the same either way.'**
  String get trustAnalyticsConsentDescription;

  /// No description provided for @trustQuietModeLabel.
  ///
  /// In en, this message translates to:
  /// **'Quiet mode'**
  String get trustQuietModeLabel;

  /// No description provided for @trustQuietModeDescription.
  ///
  /// In en, this message translates to:
  /// **'Hide suggestions without losing anything.'**
  String get trustQuietModeDescription;

  /// No description provided for @trustCalendarConsentLabel.
  ///
  /// In en, this message translates to:
  /// **'Connect your calendar'**
  String get trustCalendarConsentLabel;

  /// No description provided for @trustCalendarConsentDescription.
  ///
  /// In en, this message translates to:
  /// **'Optional and read-only. Disconnect whenever you want.'**
  String get trustCalendarConsentDescription;

  /// No description provided for @trustCalendarLockedTitle.
  ///
  /// In en, this message translates to:
  /// **'Calendar comes later'**
  String get trustCalendarLockedTitle;

  /// No description provided for @trustCalendarLockedMessage.
  ///
  /// In en, this message translates to:
  /// **'MaybeSitter will offer to connect your calendar once it has actually been useful to you. It won\'t ask before then.'**
  String get trustCalendarLockedMessage;

  /// No description provided for @trustWhatWeKnowAction.
  ///
  /// In en, this message translates to:
  /// **'What MaybeSitter knows'**
  String get trustWhatWeKnowAction;

  /// No description provided for @trustWhatWeKnowSubtitle.
  ///
  /// In en, this message translates to:
  /// **'See everything it holds about you'**
  String get trustWhatWeKnowSubtitle;

  /// No description provided for @trustRevokeTitle.
  ///
  /// In en, this message translates to:
  /// **'Turn everything off'**
  String get trustRevokeTitle;

  /// No description provided for @trustRevokeDescription.
  ///
  /// In en, this message translates to:
  /// **'Switches off suggestions, usage data and calendar. Your commitments stay.'**
  String get trustRevokeDescription;

  /// No description provided for @trustRevokeConfirmTitle.
  ///
  /// In en, this message translates to:
  /// **'Turn everything off?'**
  String get trustRevokeConfirmTitle;

  /// No description provided for @trustRevokeConfirmMessage.
  ///
  /// In en, this message translates to:
  /// **'Suggestions, usage data and any calendar connection get switched off. Your commitments stay, and you can turn things back on later.'**
  String get trustRevokeConfirmMessage;

  /// No description provided for @trustRevokedMessage.
  ///
  /// In en, this message translates to:
  /// **'Everything is switched off.'**
  String get trustRevokedMessage;

  /// No description provided for @trustDeleteTitle.
  ///
  /// In en, this message translates to:
  /// **'Delete everything'**
  String get trustDeleteTitle;

  /// No description provided for @trustDeleteDescription.
  ///
  /// In en, this message translates to:
  /// **'Removes your commitments and usage data. This can\'t be undone.'**
  String get trustDeleteDescription;

  /// No description provided for @trustDeleteConfirmTitle.
  ///
  /// In en, this message translates to:
  /// **'Delete everything?'**
  String get trustDeleteConfirmTitle;

  /// No description provided for @trustDeleteConfirmMessage.
  ///
  /// In en, this message translates to:
  /// **'This permanently removes your commitments and your usage data.'**
  String get trustDeleteConfirmMessage;

  /// No description provided for @trustDeleteAcknowledge.
  ///
  /// In en, this message translates to:
  /// **'I understand this can\'t be undone'**
  String get trustDeleteAcknowledge;

  /// No description provided for @trustDeletedMessage.
  ///
  /// In en, this message translates to:
  /// **'Your data has been deleted.'**
  String get trustDeletedMessage;

  /// No description provided for @trustUpdatedMessage.
  ///
  /// In en, this message translates to:
  /// **'Saved.'**
  String get trustUpdatedMessage;

  /// No description provided for @trustLoadFailedTitle.
  ///
  /// In en, this message translates to:
  /// **'Couldn\'t load your privacy settings'**
  String get trustLoadFailedTitle;

  /// No description provided for @trustActionFailedMessage.
  ///
  /// In en, this message translates to:
  /// **'That didn\'t save. Try again.'**
  String get trustActionFailedMessage;

  /// No description provided for @knowsTitle.
  ///
  /// In en, this message translates to:
  /// **'What MaybeSitter knows'**
  String get knowsTitle;

  /// No description provided for @knowsSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Everything it holds about you, in one list'**
  String get knowsSubtitle;

  /// No description provided for @knowsCommitmentsLabel.
  ///
  /// In en, this message translates to:
  /// **'Commitments you confirmed'**
  String get knowsCommitmentsLabel;

  /// No description provided for @knowsCommitmentsCount.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =0{None} =1{1 commitment} other{{count} commitments}}'**
  String knowsCommitmentsCount(int count);

  /// No description provided for @knowsRecommendationLabel.
  ///
  /// In en, this message translates to:
  /// **'Suggestions'**
  String get knowsRecommendationLabel;

  /// No description provided for @knowsAnalyticsLabel.
  ///
  /// In en, this message translates to:
  /// **'Usage data'**
  String get knowsAnalyticsLabel;

  /// No description provided for @knowsCalendarLabel.
  ///
  /// In en, this message translates to:
  /// **'Calendar'**
  String get knowsCalendarLabel;

  /// No description provided for @knowsOn.
  ///
  /// In en, this message translates to:
  /// **'On'**
  String get knowsOn;

  /// No description provided for @knowsOff.
  ///
  /// In en, this message translates to:
  /// **'Off'**
  String get knowsOff;

  /// No description provided for @knowsConnected.
  ///
  /// In en, this message translates to:
  /// **'Connected'**
  String get knowsConnected;

  /// No description provided for @knowsNotConnected.
  ///
  /// In en, this message translates to:
  /// **'Not connected'**
  String get knowsNotConnected;

  /// No description provided for @knowsNeverSectionTitle.
  ///
  /// In en, this message translates to:
  /// **'Never collected'**
  String get knowsNeverSectionTitle;

  /// No description provided for @knowsNoMessages.
  ///
  /// In en, this message translates to:
  /// **'Your private messages'**
  String get knowsNoMessages;

  /// No description provided for @knowsNoSensitive.
  ///
  /// In en, this message translates to:
  /// **'Guesses about your health, mood or relationships'**
  String get knowsNoSensitive;

  /// No description provided for @knowsNoMedical.
  ///
  /// In en, this message translates to:
  /// **'Any medical or diagnostic profile'**
  String get knowsNoMedical;

  /// No description provided for @knowsParticipantLabel.
  ///
  /// In en, this message translates to:
  /// **'Your pilot code'**
  String get knowsParticipantLabel;

  /// No description provided for @knowsParticipantNote.
  ///
  /// In en, this message translates to:
  /// **'A random code. It isn\'t your name and nothing here links it to one.'**
  String get knowsParticipantNote;

  /// No description provided for @pilotAccessTitle.
  ///
  /// In en, this message translates to:
  /// **'Pilot access'**
  String get pilotAccessTitle;

  /// No description provided for @pilotAccessMessage.
  ///
  /// In en, this message translates to:
  /// **'Enter the token you were issued to use this pilot build.'**
  String get pilotAccessMessage;

  /// No description provided for @pilotAccessTokenLabel.
  ///
  /// In en, this message translates to:
  /// **'Pilot token'**
  String get pilotAccessTokenLabel;

  /// No description provided for @pilotAccessContinue.
  ///
  /// In en, this message translates to:
  /// **'Continue'**
  String get pilotAccessContinue;

  /// No description provided for @pilotAccessValidating.
  ///
  /// In en, this message translates to:
  /// **'Checking access'**
  String get pilotAccessValidating;

  /// No description provided for @pilotAccessInvalidTitle.
  ///
  /// In en, this message translates to:
  /// **'That token did not work'**
  String get pilotAccessInvalidTitle;

  /// No description provided for @pilotAccessInvalidMessage.
  ///
  /// In en, this message translates to:
  /// **'Check the token you were issued and try again.'**
  String get pilotAccessInvalidMessage;

  /// No description provided for @pilotAccessNotAllowlistedTitle.
  ///
  /// In en, this message translates to:
  /// **'This token is not in the pilot'**
  String get pilotAccessNotAllowlistedTitle;

  /// No description provided for @pilotAccessNotAllowlistedMessage.
  ///
  /// In en, this message translates to:
  /// **'MaybeSitter could not admit this token to the current pilot.'**
  String get pilotAccessNotAllowlistedMessage;

  /// No description provided for @pilotAccessRevokedTitle.
  ///
  /// In en, this message translates to:
  /// **'Pilot access was revoked'**
  String get pilotAccessRevokedTitle;

  /// No description provided for @pilotAccessRevokedMessage.
  ///
  /// In en, this message translates to:
  /// **'This pilot session is closed. Your normal app screens are no longer available for this token.'**
  String get pilotAccessRevokedMessage;

  /// No description provided for @pilotAccessDeletedTitle.
  ///
  /// In en, this message translates to:
  /// **'Pilot data was deleted'**
  String get pilotAccessDeletedTitle;

  /// No description provided for @pilotAccessDeletedMessage.
  ///
  /// In en, this message translates to:
  /// **'The pilot data for this token has been deleted. The app will stay closed for this session.'**
  String get pilotAccessDeletedMessage;

  /// No description provided for @pilotAccessBackendUnavailableTitle.
  ///
  /// In en, this message translates to:
  /// **'Cannot reach MaybeSitter'**
  String get pilotAccessBackendUnavailableTitle;

  /// No description provided for @pilotAccessBackendUnavailableMessage.
  ///
  /// In en, this message translates to:
  /// **'Keep the token on this device and try again when the backend is available.'**
  String get pilotAccessBackendUnavailableMessage;

  /// No description provided for @pilotAccessRuntimeConfigTitle.
  ///
  /// In en, this message translates to:
  /// **'Pilot is not configured'**
  String get pilotAccessRuntimeConfigTitle;

  /// No description provided for @pilotAccessRuntimeConfigMessage.
  ///
  /// In en, this message translates to:
  /// **'The pilot backend is failing closed because its runtime configuration is invalid.'**
  String get pilotAccessRuntimeConfigMessage;

  /// No description provided for @pilotAccessClearToken.
  ///
  /// In en, this message translates to:
  /// **'Use a different token'**
  String get pilotAccessClearToken;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['ar', 'en', 'he'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'ar':
      return AppLocalizationsAr();
    case 'en':
      return AppLocalizationsEn();
    case 'he':
      return AppLocalizationsHe();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
