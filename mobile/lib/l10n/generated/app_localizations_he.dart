// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Hebrew (`he`).
class AppLocalizationsHe extends AppLocalizations {
  AppLocalizationsHe([String locale = 'he']) : super(locale);

  @override
  String get appName => 'Maybesitter';

  @override
  String get todayTab => 'היום';

  @override
  String get upcomingTab => 'בקרוב';

  @override
  String get activityTab => 'פעילות';

  @override
  String get settingsTab => 'הגדרות';

  @override
  String goodMorningUser(String userName) {
    return 'בוקר טוב, $userName';
  }

  @override
  String commitmentsCountToday(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count התחייבויות נותרו להיום',
      two: 'שתי התחייבויות נותרו להיום',
      one: 'התחייבות אחת נותרה להיום',
      zero: 'אין התחייבויות פעילות היום',
    );
    return '$_temp0';
  }

  @override
  String get priorityMust => 'חובה';

  @override
  String get priorityShould => 'מומלץ';

  @override
  String get priorityNice => 'אופציונלי';

  @override
  String get priorityFilterAll => 'הכול';

  @override
  String get statusPending => 'בהמתנה';

  @override
  String get statusCompleted => 'הושלמה';

  @override
  String get statusPostponed => 'נדחתה';

  @override
  String get statusCancelled => 'בוטלה';

  @override
  String get statusUnknown => 'לא ידוע';

  @override
  String get newIntentTitle => 'הוספת התחייבות';

  @override
  String get captureHintText =>
      'כתובי או דברי בחופשיות. Maybesitter מחלץ התחייבויות, זמנים ועדיפויות באופן אוטומטי.';

  @override
  String get composerInputHint =>
      'לדוגמה: \"מחר בבוקר ב-9:00 תור לרופא, ואז פגישה עם שרה לקפה ב-14:00...\"';

  @override
  String get voiceCaptureTooltip => 'הקלטה קולית';

  @override
  String get voiceCaptureStopTooltip => 'עצירת הקלטה';

  @override
  String get editingDisabledExplanation =>
      'העריכה אינה זמינה זמנית כדי להגן על מועד ההתחייבות.';

  @override
  String get privacyNote =>
      'התוכנית שלך מנותחת בפרטיות מלאה באמצעות אינטליגנציה שקטה.';

  @override
  String get analyzeAction => 'ניתוח הטקסט';

  @override
  String get reviewPlanTitle => 'בדיקת התוכנית שלך';

  @override
  String proposedCommitmentsCount(int count) {
    return 'התחייבויות מוצעות ($count)';
  }

  @override
  String confirmCommitmentsAction(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count התחייבויות',
      two: 'שתי התחייבויות',
      one: 'התחייבות אחת',
    );
    return 'אישור $_temp0';
  }

  @override
  String get cancelPlanAction => 'ביטול התוכנית כולה';

  @override
  String get editCommitmentTitle => 'עריכת התחייבות';

  @override
  String get clarificationTitle => 'הבהרה';

  @override
  String get clarificationCardHeader => 'נדרשת הבהרה';

  @override
  String get noCommitmentTitle => 'לא נמצאו התחייבויות';

  @override
  String get noCommitmentDescription =>
      'ההודעה הובנה, אך לא נמצאה תוכנית או התחייבות שניתן לשמור.';

  @override
  String get extractionErrorTitle => 'שגיאת חילוץ';

  @override
  String get extractionErrorMessage =>
      'הבינה המלאכותית לא הצליחה לנתח את התוכנית. נא לנסות שוב.';

  @override
  String commitmentsAddedSuccess(int count, String date) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'נוספו $count התחייבויות ל-$date.',
      two: 'נוספו שתי התחייבויות למחר.',
      one: 'נוספה התחייבות אחת למחר.',
    );
    return '$_temp0';
  }

  @override
  String get quietIntelligenceSubtitle =>
      'לוח הזמנים שלך עודכן באמצעות אינטליגנציה שקטה.';

  @override
  String get viewTomorrowAction => 'צפייה במחר';

  @override
  String get doneAction => 'סיום';

  @override
  String get undoAction => 'ביטול פעולה';

  @override
  String get undoSuccessMessage => 'שמירת ההתחייבויות בוטלה.';

  @override
  String get commitmentDetailTitle => 'פרטי התחייבות';

  @override
  String get scheduledDateLabel => 'תאריך מתוכנן';

  @override
  String get timeLabel => 'שעה';

  @override
  String get locationLabel => 'מיקום';

  @override
  String get categoryLabel => 'קטגוריה';

  @override
  String get markCompleteAction => 'סימון כהושלמה';

  @override
  String get moreActionsLabel => 'פעולות נוספות';

  @override
  String get markPendingAction => 'סימון כבהמתנה';

  @override
  String get postponeAction => 'דחיית התחייבות';

  @override
  String get deleteAction => 'מחיקה';

  @override
  String get deleteConfirmationTitle => 'מחיקת התחייבות';

  @override
  String deleteConfirmationMessage(String title) {
    return 'האם למחוק את \"$title\"? לא ניתן לבטל פעולה זו.';
  }

  @override
  String get postponeSheetTitle => 'דחיית התחייבות';

  @override
  String get postponeOneHour => 'בעוד שעה';

  @override
  String get postponeThreeHours => 'בעוד 3 שעות';

  @override
  String get postponeTomorrowMorning => 'מחר בבוקר';

  @override
  String get postponeNextWeek => 'בשבוע הבא';

  @override
  String get settingsTitle => 'הגדרות';

  @override
  String get settingsSubtitle => 'העדפות אפליקציה וחשבון';

  @override
  String get appearanceTitle => 'מראה';

  @override
  String get appearanceSubtitle => 'העדפות ערכת נושא';

  @override
  String get themeModeLabel => 'מצב ערכת נושא';

  @override
  String get themeSystem => 'מערכת';

  @override
  String get themeLight => 'בהיר';

  @override
  String get themeDark => 'כהה';

  @override
  String get notificationsTitle => 'התראות';

  @override
  String get notificationsSubtitle => 'תזכורות ועדכונים שקטים';

  @override
  String get notificationsEnabled => 'פעיל';

  @override
  String get notificationsDisabled => 'מושבת';

  @override
  String get privacyTitle => 'פרטיות ונתונים';

  @override
  String get privacySubtitle => 'נתונים מקומיים וטלמטריה';

  @override
  String get encryptionLabel => 'הצפנת נתונים מקומיים';

  @override
  String get analyticsLabel => 'ביטול השתתפות בנתוני עתק';

  @override
  String get deleteAllDataAction => 'מחיקת כל הנתונים המקומיים';

  @override
  String get deleteAllDataTitle => 'מחיקת כל הנתונים המקומיים';

  @override
  String get deleteAllDataMessage =>
      'האם למחוק את כל ההתחייבויות וההיסטוריה השמורה? לא ניתן לבטל פעולה זו.';

  @override
  String get dataClearedMessage => 'כל הנתונים המקומיים נמחקו.';

  @override
  String get languageTitle => 'שפה';

  @override
  String get languageSubtitle => 'שפת האפליקציה וכיוון הממשק';

  @override
  String get languageSystem => 'ברירת מחדל של המערכת';

  @override
  String get languageEnglish => 'English';

  @override
  String get languageArabic => 'العربية';

  @override
  String get languageHebrew => 'עברית';

  @override
  String get activityTitle => 'היסטוריית פעילות';

  @override
  String get activitySubtitle => 'יומן זמנים של עדכונים ועיבודי בינה מלאכותית';

  @override
  String get emptyActivityTitle => 'אין עדיין פעילות';

  @override
  String get emptyActivityDescription =>
      'פעולות, התחייבויות ויומני עיבוד יופיעו כאן.';

  @override
  String get welcomeTitle => 'ברוכים הבאים ל-Maybesitter';

  @override
  String get welcomeSubtitle =>
      'אינטליגנציה שקטה להתחייבויות היומיות ולתוכניות הגמישות שלך.';

  @override
  String get getStartedAction => 'להתחיל';

  @override
  String get skipAction => 'דילוג';

  @override
  String get cancelAction => 'ביטול';

  @override
  String get saveAction => 'שמירה';

  @override
  String get retryAction => 'ניסיון נוסף';

  @override
  String get backAction => 'חזרה';

  @override
  String get closeAction => 'סגירה';

  @override
  String get offlineBannerText => 'לא מחובר — השינויים יישמרו מקומית';

  @override
  String get noCommitmentsTodayTitle => 'אין התחייבויות היום';

  @override
  String get noCommitmentsTodayDesc =>
      'היום שלך פנוי! לחץ למטה להוספת תוכנית חדשה.';

  @override
  String get noUpcomingCommitmentsTitle => 'אין התחייבויות קרובות';

  @override
  String get noUpcomingCommitmentsDesc =>
      'אין תוכניות מתוכננות עבור הסינון שנבחר.';

  @override
  String get capturePlanAction => 'הוספת התחייבות';

  @override
  String get processingLabel =>
      'מנתח את התוכנית שלך באמצעות אינטליגנציה שקטה...';

  @override
  String get nowGroupHeader => 'עכשיו • חובה';

  @override
  String get laterTodayGroupHeader => 'היום בהמשך • מומלץ';

  @override
  String get optionalGroupHeader => 'אופציונלי • אופציונלי';

  @override
  String get completedGroupHeader => 'הושלמו';

  @override
  String get tomorrowGroupHeader => 'מחר';

  @override
  String get thisWeekGroupHeader => 'השבוע';

  @override
  String get laterGroupHeader => 'בהמשך';

  @override
  String get agendaView => 'סדר יום';

  @override
  String get compactCalendarView => 'לוח שנה מקוצר';

  @override
  String itemsCountLabel(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count פריטים',
      two: 'שני פריטים',
      one: 'פריט אחד',
    );
    return '$_temp0';
  }

  @override
  String doneCountLabel(int count) {
    return 'הושלמו $count';
  }

  @override
  String get unsupportedRequestTitle => 'בקשה לא נתמכת';

  @override
  String get unsupportedRequestMessage =>
      'לא ניתן היה לעבד בקשה זו כהתחייבות או כתוכנית.';

  @override
  String get networkErrorMessage => 'לא ניתן להתחבר לשרת. נא לבדוק את החיבור.';

  @override
  String get proposalExpiredMessage =>
      'פג תוקף התוכנית המוצעת. נא לנתח את התוכנית מחדש.';

  @override
  String get validationErrorMessage => 'שגיאת אימות שרת. נא לבדוק את הנתונים.';

  @override
  String get confirmFailedMessage => 'אישור התוכנית בשרת נכשל.';

  @override
  String get noDateGroupHeader => 'ללא תאריך';

  @override
  String get overdueGroupHeader => 'באיחור';

  @override
  String get reminderHistoryTitle => 'היסטוריית תזכורות';

  @override
  String get reminderHistorySubtitle => 'יומן ניסיונות שליחת התראות';

  @override
  String get nextStepSectionTitle => 'הצעד הבא שלך';

  @override
  String get nextStepProposalNotice => 'זו הצעה. עדיין לא השתנה שום דבר.';

  @override
  String get nextStepWhyTitle => 'למה דווקא זה';

  @override
  String get nextStepNoSensitiveInference =>
      'לא נעשה שימוש בהשערות רגישות כדי לבחור את זה.';

  @override
  String get nextStepActionAccept => 'מאשר';

  @override
  String get nextStepActionEdit => 'עריכה';

  @override
  String get nextStepActionDefer => 'לא עכשיו';

  @override
  String get nextStepActionDismiss => 'התעלמות';

  @override
  String get nextStepActionDone => 'כבר עשיתי';

  @override
  String get nextStepAcceptedMessage => 'אושר. אפשר להתחיל מתי שתרצה.';

  @override
  String get nextStepEditedMessage => 'עודכן.';

  @override
  String get nextStepDeferredMessage => 'נדחה לעת עתה.';

  @override
  String get nextStepDismissedMessage => 'הוסר.';

  @override
  String get nextStepDoneMessage => 'סומן כבוצע.';

  @override
  String get nextStepShowAnotherAction => 'הצע משהו אחר';

  @override
  String get nextStepEmptyTitle => 'אין מה להציע כרגע';

  @override
  String get nextStepEmptyMessage => 'תעד משהו ואשר אותו, וכאן יופיע צעד בא.';

  @override
  String get nextStepInsufficientTitle => 'עדיין אין מספיק מידע';

  @override
  String get nextStepInsufficientMessage =>
      'אשר עוד כמה התחייבויות ותופיע הצעה.';

  @override
  String get nextStepStaleMessage =>
      'ההצעה השתנתה בזמן שהתלבטת. זו ההצעה הנוכחית.';

  @override
  String get nextStepLoadingLabel => 'מחפש את הצעד הבא שלך';

  @override
  String get nextStepFailedTitle => 'לא הצלחנו לטעון הצעה';

  @override
  String get nextStepEditTitle => 'עריכת הצעד';

  @override
  String get nextStepEditFieldLabel => 'הצעד הבא';

  @override
  String get nextStepEditHelp => 'נסח את זה כמו שבאמת תעשה את זה.';

  @override
  String get evidenceDueToday => 'להיום';

  @override
  String get evidenceOverdue => 'עבר התאריך';

  @override
  String get evidenceConfirmedByYou => 'אישרת את זה';

  @override
  String get evidenceHighPriority => 'סימנת כהכרחי';

  @override
  String get evidenceScheduledSoon => 'מתקרב';

  @override
  String get evidenceOnlyOpenItem => 'זה הפריט הפתוח היחיד שלך';

  @override
  String get evidenceOther => 'על סמך התחייבויות שאישרת';

  @override
  String get pilotStateUnauthorizedTitle => 'המכשיר הזה אינו בפיילוט';

  @override
  String get pilotStateUnauthorizedMessage =>
      'קוד הפיילוט במכשיר הזה אינו ברשימת המשתתפים, ולכן ההצעות כבויות. אם זו טעות, פנה למי שהזמין אותך.';

  @override
  String get pilotStateWrongInstanceTitle => 'מכשיר פיילוט לא תואם';

  @override
  String get pilotStateWrongInstanceMessage =>
      'העותק הזה של האפליקציה מוגדר למשתתף אחר. השתמש בקישור שנשלח אליך.';

  @override
  String get pilotStateSuspendedTitle => 'הגישה שלך לפיילוט הושהתה';

  @override
  String get pilotStateSuspendedMessage =>
      'מי שמנהל את הפיילוט השהה את הגישה שלך. ההתחייבויות שלך שמורות ושום דבר לא נמחק.';

  @override
  String get pilotStatePausedTitle => 'ההצעות מושהות';

  @override
  String get pilotStatePausedMessage =>
      'ההצעות מושהות כרגע לכל המשתתפים. התיעוד עדיין עובד ושום דבר לא אבד.';

  @override
  String get pilotStateDisabledTitle => 'ההצעות כבויות';

  @override
  String get pilotStateDisabledMessage =>
      'בגרסה הזו ההצעות כבויות. התיעוד וההתחייבויות עובדים כרגיל.';

  @override
  String get pilotStateConsentRequiredTitle => 'רוצה הצעה לצעד הבא?';

  @override
  String get pilotStateConsentRequiredMessage =>
      'MaybeSitter יכול להציע צעד אחד מתוך התחייבויות שכבר אישרת. הוא לא משנה דבר מעצמו, ואפשר לכבות את זה בכל רגע.';

  @override
  String get pilotStateConsentRequiredAction => 'הפעלת הצעות';

  @override
  String get pilotStateQuietTitle => 'מצב שקט פעיל';

  @override
  String get pilotStateQuietMessage =>
      'ההצעות מוסתרות עד שתכבה את המצב השקט. שום דבר לא נמחק.';

  @override
  String get pilotStateQuietAction => 'כיבוי מצב שקט';

  @override
  String get pilotStateRevokedTitle => 'כיבית את ההצעות';

  @override
  String get pilotStateRevokedMessage =>
      'ההתחייבויות שלך עדיין כאן. אפשר להפעיל הצעות מחדש מתי שתרצה.';

  @override
  String get pilotStateRevokedAction => 'הפעלת הצעות מחדש';

  @override
  String get pilotStateDeletedTitle => 'הנתונים שלך נמחקו';

  @override
  String get pilotStateDeletedMessage =>
      'כבר לא נשמר עליך שום דבר. תודה שהשתתפת.';

  @override
  String get pilotStateUnknownTitle => 'ההצעות אינן זמינות';

  @override
  String get pilotStateUnknownMessage =>
      'לא ניתן לאמת את מצבך בפיילוט, ולכן לא מוצגת הצעה. התיעוד עדיין עובד.';

  @override
  String get pilotStateOfflineTitle => 'אין חיבור ל-MaybeSitter';

  @override
  String get pilotStateOfflineMessage =>
      'ההתחייבויות שלך שמורות במכשיר. נסה שוב בעוד רגע.';

  @override
  String get trustCenterTitle => 'אמון ופרטיות';

  @override
  String get trustCenterSubtitle => 'מה פעיל, מה כבוי, ואיך לשנות';

  @override
  String get trustSectionControls => 'השליטה שלך';

  @override
  String get trustSectionEnding => 'הפסקה';

  @override
  String get trustRecommendationConsentLabel => 'הצעות';

  @override
  String get trustRecommendationConsentDescription =>
      'לאפשר ל-MaybeSitter להציע צעד אחד. הוא רק מציע.';

  @override
  String get trustAnalyticsConsentLabel => 'שיתוף נתוני שימוש';

  @override
  String get trustAnalyticsConsentDescription =>
      'מספרים בלבד, אף פעם לא הטקסט שלך. האפליקציה עובדת אותו דבר כך או כך.';

  @override
  String get trustQuietModeLabel => 'מצב שקט';

  @override
  String get trustQuietModeDescription => 'להסתיר הצעות בלי לאבד שום דבר.';

  @override
  String get trustCalendarConsentLabel => 'חיבור היומן';

  @override
  String get trustCalendarConsentDescription =>
      'אופציונלי ולקריאה בלבד. אפשר לנתק בכל רגע.';

  @override
  String get trustCalendarLockedTitle => 'היומן בהמשך';

  @override
  String get trustCalendarLockedMessage =>
      'MaybeSitter יציע לחבר את היומן שלך רק אחרי שבאמת יועיל לך. עד אז הוא לא יבקש.';

  @override
  String get trustWhatWeKnowAction => 'מה MaybeSitter יודע';

  @override
  String get trustWhatWeKnowSubtitle => 'כל מה שהוא מחזיק עליך';

  @override
  String get trustRevokeTitle => 'כיבוי הכול';

  @override
  String get trustRevokeDescription =>
      'מכבה הצעות, נתוני שימוש ויומן. ההתחייבויות שלך נשארות.';

  @override
  String get trustRevokeConfirmTitle => 'לכבות הכול?';

  @override
  String get trustRevokeConfirmMessage =>
      'הצעות, נתוני שימוש וכל חיבור ליומן ייכבו. ההתחייבויות שלך נשארות, ואפשר להפעיל שוב בהמשך.';

  @override
  String get trustRevokedMessage => 'הכול כובה.';

  @override
  String get trustDeleteTitle => 'מחיקת הכול';

  @override
  String get trustDeleteDescription =>
      'מוחק את ההתחייבויות ואת נתוני השימוש שלך. אי אפשר לבטל.';

  @override
  String get trustDeleteConfirmTitle => 'למחוק הכול?';

  @override
  String get trustDeleteConfirmMessage =>
      'הפעולה מוחקת לצמיתות את ההתחייבויות ואת נתוני השימוש שלך.';

  @override
  String get trustDeleteAcknowledge => 'אני מבין שאי אפשר לבטל';

  @override
  String get trustDeletedMessage => 'הנתונים שלך נמחקו.';

  @override
  String get trustUpdatedMessage => 'נשמר.';

  @override
  String get trustLoadFailedTitle => 'לא הצלחנו לטעון את הגדרות הפרטיות';

  @override
  String get trustActionFailedMessage => 'השינוי לא נשמר. נסה שוב.';

  @override
  String get knowsTitle => 'מה MaybeSitter יודע';

  @override
  String get knowsSubtitle => 'כל מה שהוא מחזיק עליך, ברשימה אחת';

  @override
  String get knowsCommitmentsLabel => 'התחייבויות שאישרת';

  @override
  String knowsCommitmentsCount(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count התחייבויות',
      two: 'שתי התחייבויות',
      one: 'התחייבות אחת',
      zero: 'אין',
    );
    return '$_temp0';
  }

  @override
  String get knowsRecommendationLabel => 'הצעות';

  @override
  String get knowsAnalyticsLabel => 'נתוני שימוש';

  @override
  String get knowsCalendarLabel => 'יומן';

  @override
  String get knowsOn => 'פעיל';

  @override
  String get knowsOff => 'כבוי';

  @override
  String get knowsConnected => 'מחובר';

  @override
  String get knowsNotConnected => 'לא מחובר';

  @override
  String get knowsNeverSectionTitle => 'לעולם לא נאסף';

  @override
  String get knowsNoMessages => 'ההודעות הפרטיות שלך';

  @override
  String get knowsNoSensitive => 'השערות על הבריאות, מצב הרוח או הקשרים שלך';

  @override
  String get knowsNoMedical => 'כל פרופיל רפואי או אבחנתי';

  @override
  String get knowsParticipantLabel => 'קוד הפיילוט שלך';

  @override
  String get knowsParticipantNote =>
      'קוד אקראי. הוא אינו שמך ושום דבר כאן לא מקשר בינו לבין שמך.';

  @override
  String get pilotAccessTitle => 'גישה לפיילוט';

  @override
  String get pilotAccessMessage =>
      'הזן את הטוקן שקיבלת כדי להשתמש בגרסת הפיילוט.';

  @override
  String get pilotAccessTokenLabel => 'טוקן פיילוט';

  @override
  String get pilotAccessContinue => 'המשך';

  @override
  String get pilotAccessValidating => 'בודקים גישה';

  @override
  String get pilotAccessInvalidTitle => 'הטוקן הזה לא עבד';

  @override
  String get pilotAccessInvalidMessage => 'בדוק את הטוקן שקיבלת ונסה שוב.';

  @override
  String get pilotAccessNotAllowlistedTitle => 'הטוקן הזה אינו בפיילוט';

  @override
  String get pilotAccessNotAllowlistedMessage =>
      'MaybeSitter לא הצליח לאשר את הטוקן לפיילוט הנוכחי.';

  @override
  String get pilotAccessRevokedTitle => 'הגישה לפיילוט בוטלה';

  @override
  String get pilotAccessRevokedMessage =>
      'סשן הפיילוט הזה נסגר. מסכי האפליקציה הרגילים אינם זמינים עוד לטוקן הזה.';

  @override
  String get pilotAccessDeletedTitle => 'נתוני הפיילוט נמחקו';

  @override
  String get pilotAccessDeletedMessage =>
      'נתוני הפיילוט עבור הטוקן הזה נמחקו. האפליקציה תישאר סגורה לסשן הזה.';

  @override
  String get pilotAccessBackendUnavailableTitle =>
      'לא ניתן להגיע ל-MaybeSitter';

  @override
  String get pilotAccessBackendUnavailableMessage =>
      'שמור את הטוקן במכשיר הזה ונסה שוב כשהשרת זמין.';

  @override
  String get pilotAccessRuntimeConfigTitle => 'הפיילוט אינו מוגדר';

  @override
  String get pilotAccessRuntimeConfigMessage =>
      'שרת הפיילוט נסגר בצורה בטוחה כי הגדרות ההרצה אינן תקינות.';

  @override
  String get pilotAccessClearToken => 'להשתמש בטוקן אחר';

  @override
  String get alphaFlagTooltip => 'דווח על בעיה';

  @override
  String get alphaFlagTitle => 'דווח על בעיה בשלב הזה';

  @override
  String get alphaFlagCategoryWrong => 'ההמלצה הזו שגויה';

  @override
  String get alphaFlagCategoryMisunderstood => 'הוא לא הבין אותי';

  @override
  String get alphaFlagCategoryNotUseful => 'זה לא היה מועיל';

  @override
  String get alphaFlagCategoryInvasive => 'זה הרגיש פולשני';

  @override
  String get alphaFlagCategoryTechnical => 'בעיה טכנית';

  @override
  String get alphaFlagNoteHint => 'פרטים אופציונליים';

  @override
  String get alphaFlagPickCategory => 'אנא בחר קטגוריה';

  @override
  String get alphaFlagSubmit => 'שלח דוח';

  @override
  String get alphaFlagSent => 'תודה — הדוח התקבל.';

  @override
  String get alphaFlagDisabled => 'הדיווח אינו מופעל בגרסה זו.';
}
