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
}
