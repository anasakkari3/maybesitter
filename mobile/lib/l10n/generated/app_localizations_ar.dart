// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Arabic (`ar`).
class AppLocalizationsAr extends AppLocalizations {
  AppLocalizationsAr([String locale = 'ar']) : super(locale);

  @override
  String get appName => 'Maybesitter';

  @override
  String get todayTab => 'اليوم';

  @override
  String get upcomingTab => 'القادمة';

  @override
  String get activityTab => 'النشاط';

  @override
  String get settingsTab => 'الإعدادات';

  @override
  String goodMorningUser(String userName) {
    return 'صباح الخير، $userName';
  }

  @override
  String commitmentsCountToday(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count التزام متبقٍ اليوم',
      many: '$count التزامًا متبقيًا اليوم',
      few: '$count التزامات متبقية اليوم',
      two: 'التزامان متبقيان اليوم',
      one: 'التزام واحد متبقٍ اليوم',
      zero: 'لا توجد التزامات نشطة اليوم',
    );
    return '$_temp0';
  }

  @override
  String get priorityMust => 'ضروري';

  @override
  String get priorityShould => 'مستحسن';

  @override
  String get priorityNice => 'اختياري';

  @override
  String get priorityFilterAll => 'الكل';

  @override
  String get statusPending => 'قيد الانتظار';

  @override
  String get statusCompleted => 'مكتمل';

  @override
  String get statusPostponed => 'مؤجل';

  @override
  String get statusCancelled => 'ملغى';

  @override
  String get statusUnknown => 'غير معروف';

  @override
  String get newIntentTitle => 'إضافة التزام';

  @override
  String get captureHintText =>
      'اكتب أو تحدث بحرية. يستخرج Maybesitter الالتزامات والأوقات والأولويات تلقائيًا.';

  @override
  String get composerInputHint =>
      'مثال: \"غدًا صباحًا الساعة 9 موعد الطبيب، ثم لقاء سارة للقهوة الساعة 2 ظهرًا...\"';

  @override
  String get voiceCaptureTooltip => 'تسجيل صوتي';

  @override
  String get voiceCaptureStopTooltip => 'إيقاف التسجيل';

  @override
  String get privacyNote => 'يتم تحليل خطتك بخصوصية تامة عبر الذكاء الهادئ.';

  @override
  String get analyzeAction => 'تحليل النص';

  @override
  String get reviewPlanTitle => 'مراجعة خطتك';

  @override
  String proposedCommitmentsCount(int count) {
    return 'الالتزامات المقترحة ($count)';
  }

  @override
  String confirmCommitmentsAction(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count التزام',
      many: '$count التزامًا',
      few: '$count التزامات',
      two: 'التزامين',
      one: 'التزام واحد',
    );
    return 'تأكيد $_temp0';
  }

  @override
  String get cancelPlanAction => 'إلغاء الخطة بالكامل';

  @override
  String get editCommitmentTitle => 'تعديل الالتزام';

  @override
  String get clarificationTitle => 'توضيح';

  @override
  String get clarificationCardHeader => 'مطلوب توضيح';

  @override
  String get noCommitmentTitle => 'لم يتم العثور على التزامات';

  @override
  String get noCommitmentDescription =>
      'تم فهم الرسالة، ولكن لم يتم العثور على خطة أو التزام يمكن حفظه.';

  @override
  String get extractionErrorTitle => 'خطأ في الاستخراج';

  @override
  String get extractionErrorMessage =>
      'تعذر على الذكاء الاصطناعي تحليل خطتك. يرجى المحاولة مرة أخرى.';

  @override
  String commitmentsAddedSuccess(int count, String date) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'تمت إضافة $count التزام ليوم غد.',
      many: 'تمت إضافة $count التزامًا ليوم غد.',
      few: 'تمت إضافة $count التزامات ليوم غد.',
      two: 'تمت إضافة التزامين ليوم غد.',
      one: 'تمت إضافة التزام واحد ليوم غد.',
    );
    return '$_temp0';
  }

  @override
  String get quietIntelligenceSubtitle =>
      'تم تحديث جدولك الزمني عبر الذكاء الهادئ.';

  @override
  String get viewTomorrowAction => 'عرض الغد';

  @override
  String get doneAction => 'تم';

  @override
  String get undoAction => 'تراجع';

  @override
  String get undoSuccessMessage => 'تم التراجع عن حفظ الالتزامات.';

  @override
  String get commitmentDetailTitle => 'تفاصيل الالتزام';

  @override
  String get scheduledDateLabel => 'التاريخ المحدد';

  @override
  String get timeLabel => 'الوقت';

  @override
  String get locationLabel => 'الموقع';

  @override
  String get categoryLabel => 'الفئة';

  @override
  String get markCompleteAction => 'تحديد كمكتمل';

  @override
  String get markPendingAction => 'تحديد كقيد الانتظار';

  @override
  String get postponeAction => 'تأجيل الالتزام';

  @override
  String get deleteAction => 'حذف';

  @override
  String get deleteConfirmationTitle => 'حذف الالتزام';

  @override
  String deleteConfirmationMessage(String title) {
    return 'هل أنت متأكد من رغبتك في حذف \"$title\"؟ لا يمكن التراجع عن هذا الإجراء.';
  }

  @override
  String get postponeSheetTitle => 'تأجيل الالتزام';

  @override
  String get postponeOneHour => 'بعد ساعة واحدة';

  @override
  String get postponeThreeHours => 'بعد 3 ساعات';

  @override
  String get postponeTomorrowMorning => 'صباح الغد';

  @override
  String get postponeNextWeek => 'الأسبوع القادم';

  @override
  String get settingsTitle => 'الإعدادات';

  @override
  String get settingsSubtitle => 'تفضيلات التطبيق والحساب';

  @override
  String get appearanceTitle => 'المظهر';

  @override
  String get appearanceSubtitle => 'تفضيلات السمات';

  @override
  String get themeModeLabel => 'نمط السمة';

  @override
  String get themeSystem => 'النظام';

  @override
  String get themeLight => 'فاتح';

  @override
  String get themeDark => 'داكن';

  @override
  String get notificationsTitle => 'الإشعارات';

  @override
  String get notificationsSubtitle => 'التذكيرات والتحديثات الهادئة';

  @override
  String get notificationsEnabled => 'مفعلة';

  @override
  String get notificationsDisabled => 'معطلة';

  @override
  String get privacyTitle => 'الخصوصية والبيانات';

  @override
  String get privacySubtitle => 'البيانات المحلية والتحليلات';

  @override
  String get encryptionLabel => 'تشفير البيانات المحلية';

  @override
  String get analyticsLabel => 'إلغاء الاشتراك في التحليلات';

  @override
  String get deleteAllDataAction => 'حذف جميع البيانات المحلية';

  @override
  String get deleteAllDataTitle => 'حذف جميع البيانات المحلية';

  @override
  String get deleteAllDataMessage =>
      'هل أنت متأكد من رغبتك في مسح جميع الالتزامات والسجلات المخزنة؟ لا يمكن التراجع عن هذا الإجراء.';

  @override
  String get dataClearedMessage => 'تم مسح جميع البيانات المحلية.';

  @override
  String get languageTitle => 'اللغة';

  @override
  String get languageSubtitle => 'لغة التطبيق واتجاه الواجهة';

  @override
  String get languageSystem => 'افتراضي النظام';

  @override
  String get languageEnglish => 'English';

  @override
  String get languageArabic => 'العربية';

  @override
  String get languageHebrew => 'עברית';

  @override
  String get activityTitle => 'سجل النشاط';

  @override
  String get activitySubtitle => 'سجل زمني للتحديثات وعمليات الذكاء الاصطناعي';

  @override
  String get emptyActivityTitle => 'لا يوجد نشاط بعد';

  @override
  String get emptyActivityDescription =>
      'ستظهر هنا الإجراءات والالتزامات وسجلات المعالجة.';

  @override
  String get welcomeTitle => 'مرحبًا بك في Maybesitter';

  @override
  String get welcomeSubtitle => 'ذكاء هادئ لالتزاماتك اليومية وخططك المرنة.';

  @override
  String get getStartedAction => 'البدء';

  @override
  String get skipAction => 'تخطي';

  @override
  String get cancelAction => 'إلغاء';

  @override
  String get saveAction => 'حفظ';

  @override
  String get retryAction => 'إعادة المحاولة';

  @override
  String get backAction => 'رجوع';

  @override
  String get closeAction => 'إغلاق';

  @override
  String get offlineBannerText => 'غير متصل — سيتم حفظ التغييرات محليًا';

  @override
  String get noCommitmentsTodayTitle => 'لا توجد التزامات اليوم';

  @override
  String get noCommitmentsTodayDesc =>
      'يومك فارغ! اضغط أدناه لإضافة خطة جديدة.';

  @override
  String get noUpcomingCommitmentsTitle => 'لا توجد التزامات قادمة';

  @override
  String get noUpcomingCommitmentsDesc => 'لا توجد خطط مجدولة للتصفية المحددة.';

  @override
  String get capturePlanAction => 'إضافة التزام';

  @override
  String get processingLabel => 'جاري تحليل خطتك عبر الذكاء الهادئ...';

  @override
  String get nowGroupHeader => 'الآن • ضروري';

  @override
  String get laterTodayGroupHeader => 'لاحقًا اليوم • مستحسن';

  @override
  String get optionalGroupHeader => 'اختياري • اختياري';

  @override
  String get completedGroupHeader => 'المكتملة';

  @override
  String get tomorrowGroupHeader => 'غدًا';

  @override
  String get thisWeekGroupHeader => 'هذا الأسبوع';

  @override
  String get laterGroupHeader => 'لاحقًا';

  @override
  String get agendaView => 'الجدول الزمني';

  @override
  String get compactCalendarView => 'التقويم المصغر';

  @override
  String itemsCountLabel(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count عنصر',
      many: '$count عنصرًا',
      few: '$count عناصر',
      two: 'عنصران',
      one: 'عنصر واحد',
    );
    return '$_temp0';
  }

  @override
  String doneCountLabel(int count) {
    return 'تم إنجاز $count';
  }

  @override
  String get unsupportedRequestTitle => 'طلب غير مدعوم';

  @override
  String get unsupportedRequestMessage =>
      'تعذر معالجة هذا الطلب كالتزام أو خطة.';

  @override
  String get networkErrorMessage =>
      'تعذر الاتصال بالخادم. يرجى التحقق من الاتصال.';

  @override
  String get proposalExpiredMessage =>
      'انتهت صلاحية الخطة المقترحة. يرجى إعادة تحليل خطتك.';

  @override
  String get validationErrorMessage =>
      'خطأ في التحقق من البيانات. يرجى مراجعة المدخلات.';

  @override
  String get confirmFailedMessage => 'فشل تأكيد الخطة على الخادم.';

  @override
  String get noDateGroupHeader => 'بدون تاريخ';

  @override
  String get overdueGroupHeader => 'المتأخرة';

  @override
  String get reminderHistoryTitle => 'سجل التذكيرات';

  @override
  String get reminderHistorySubtitle => 'سجل محاولات إرسال الإشعارات';
}
