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
  String get editingDisabledExplanation =>
      'التعديل غير متاح مؤقتًا لحماية موعد الالتزام.';

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
  String get moreActionsLabel => 'المزيد من الإجراءات';

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

  @override
  String get nextStepSectionTitle => 'خطوتك التالية';

  @override
  String get nextStepProposalNotice => 'هذا اقتراح. لم يتغيّر أي شيء بعد.';

  @override
  String get nextStepWhyTitle => 'لماذا هذه الخطوة';

  @override
  String get nextStepNoSensitiveInference =>
      'لم تُستخدم أي استنتاجات حسّاسة لاختيارها.';

  @override
  String get nextStepActionAccept => 'قبول';

  @override
  String get nextStepActionEdit => 'تعديل';

  @override
  String get nextStepActionDefer => 'ليس الآن';

  @override
  String get nextStepActionDismiss => 'تجاهل';

  @override
  String get nextStepActionDone => 'أنجزتها سابقًا';

  @override
  String get nextStepAcceptedMessage => 'تم القبول. ابدأ بها متى شئت.';

  @override
  String get nextStepEditedMessage => 'تم التحديث.';

  @override
  String get nextStepDeferredMessage => 'أجّلناها الآن.';

  @override
  String get nextStepDismissedMessage => 'تم التجاهل.';

  @override
  String get nextStepDoneMessage => 'سُجّلت كمنجَزة.';

  @override
  String get nextStepShowAnotherAction => 'اقترح غيرها';

  @override
  String get nextStepEmptyTitle => 'لا يوجد اقتراح الآن';

  @override
  String get nextStepEmptyMessage =>
      'سجّل شيئًا وأكّده، وستظهر لك خطوة تالية هنا.';

  @override
  String get nextStepInsufficientTitle => 'المعطيات غير كافية بعد';

  @override
  String get nextStepInsufficientMessage =>
      'أكّد بضعة التزامات إضافية وسيظهر اقتراح.';

  @override
  String get nextStepStaleMessage =>
      'تغيّر الاقتراح أثناء اتخاذك القرار. هذا هو الاقتراح الحالي.';

  @override
  String get nextStepLoadingLabel => 'جارٍ إيجاد خطوتك التالية';

  @override
  String get nextStepFailedTitle => 'تعذّر تحميل الاقتراح';

  @override
  String get nextStepEditTitle => 'تعديل هذه الخطوة';

  @override
  String get nextStepEditFieldLabel => 'الخطوة التالية';

  @override
  String get nextStepEditHelp => 'صُغها بالطريقة التي ستنفّذها بها فعلًا.';

  @override
  String get evidenceDueToday => 'مستحقّة اليوم';

  @override
  String get evidenceOverdue => 'تجاوزت موعدها';

  @override
  String get evidenceConfirmedByYou => 'أنت أكّدتها';

  @override
  String get evidenceHighPriority => 'وضعتها ضمن الضروري';

  @override
  String get evidenceScheduledSoon => 'موعدها قريب';

  @override
  String get evidenceOnlyOpenItem => 'هي البند المفتوح الوحيد لديك';

  @override
  String get evidenceOther => 'استنادًا إلى التزامات أكّدتها';

  @override
  String get pilotStateUnauthorizedTitle => 'هذا الجهاز ليس ضمن التجربة';

  @override
  String get pilotStateUnauthorizedMessage =>
      'رمز التجربة على هذا الجهاز غير مُدرج في قائمة المشاركين، لذلك الاقتراحات متوقّفة. إذا بدا هذا خطأً فتواصل مع من دعاك.';

  @override
  String get pilotStateWrongInstanceTitle => 'جهاز تجربة غير مطابق';

  @override
  String get pilotStateWrongInstanceMessage =>
      'هذه النسخة من التطبيق مُهيّأة لمشارك آخر. استخدم الرابط الذي أُرسل إليك.';

  @override
  String get pilotStateSuspendedTitle => 'تم إيقاف وصولك مؤقتًا';

  @override
  String get pilotStateSuspendedMessage =>
      'أوقف أحد المشرفين على التجربة وصولك مؤقتًا. التزاماتك محفوظة ولم يُحذف أي شيء.';

  @override
  String get pilotStatePausedTitle => 'الاقتراحات متوقّفة مؤقتًا';

  @override
  String get pilotStatePausedMessage =>
      'الاقتراحات متوقّفة حاليًا لجميع المشاركين. التسجيل ما زال يعمل ولم يُفقد شيء.';

  @override
  String get pilotStateDisabledTitle => 'الاقتراحات مُعطّلة';

  @override
  String get pilotStateDisabledMessage =>
      'الاقتراحات مُعطّلة في هذه النسخة. التسجيل والالتزامات تعمل كالمعتاد.';

  @override
  String get pilotStateConsentRequiredTitle => 'هل تريد اقتراح خطوة تالية؟';

  @override
  String get pilotStateConsentRequiredMessage =>
      'يستطيع MaybeSitter أن يقترح خطوة تالية واحدة من التزامات أكّدتها مسبقًا. لا يغيّر شيئًا من تلقاء نفسه، ويمكنك إيقاف ذلك متى شئت.';

  @override
  String get pilotStateConsentRequiredAction => 'تفعيل الاقتراحات';

  @override
  String get pilotStateQuietTitle => 'الوضع الهادئ مفعّل';

  @override
  String get pilotStateQuietMessage =>
      'تبقى الاقتراحات مخفيّة حتى تُوقف الوضع الهادئ. لم يُحذف أي شيء.';

  @override
  String get pilotStateQuietAction => 'إيقاف الوضع الهادئ';

  @override
  String get pilotStateRevokedTitle => 'أوقفت الاقتراحات';

  @override
  String get pilotStateRevokedMessage =>
      'التزاماتك ما زالت هنا. يمكنك إعادة تفعيل الاقتراحات متى أردت.';

  @override
  String get pilotStateRevokedAction => 'إعادة تفعيل الاقتراحات';

  @override
  String get pilotStateDeletedTitle => 'حُذفت بياناتك';

  @override
  String get pilotStateDeletedMessage =>
      'لم يعد يُحفظ لك أي شيء. شكرًا لمشاركتك.';

  @override
  String get pilotStateUnknownTitle => 'الاقتراحات غير متاحة';

  @override
  String get pilotStateUnknownMessage =>
      'تعذّر التأكّد من حالتك في التجربة، لذلك لا يُعرض اقتراح. التسجيل ما زال يعمل.';

  @override
  String get pilotStateOfflineTitle => 'تعذّر الاتصال بـ MaybeSitter';

  @override
  String get pilotStateOfflineMessage =>
      'التزاماتك محفوظة على هذا الجهاز. أعد المحاولة بعد قليل.';

  @override
  String get trustCenterTitle => 'الثقة والخصوصية';

  @override
  String get trustCenterSubtitle => 'ما هو مفعّل، وما هو متوقّف، وكيف تغيّره';

  @override
  String get trustSectionControls => 'أدوات التحكّم';

  @override
  String get trustSectionEnding => 'الإيقاف';

  @override
  String get trustRecommendationConsentLabel => 'الاقتراحات';

  @override
  String get trustRecommendationConsentDescription =>
      'اسمح لـ MaybeSitter باقتراح خطوة تالية واحدة. هو يقترح فقط.';

  @override
  String get trustAnalyticsConsentLabel => 'مشاركة بيانات الاستخدام';

  @override
  String get trustAnalyticsConsentDescription =>
      'أعداد فقط، ولا يشمل نصوصك. التطبيق يعمل بالطريقة نفسها في الحالتين.';

  @override
  String get trustQuietModeLabel => 'الوضع الهادئ';

  @override
  String get trustQuietModeDescription => 'إخفاء الاقتراحات دون فقدان أي شيء.';

  @override
  String get trustCalendarConsentLabel => 'ربط التقويم';

  @override
  String get trustCalendarConsentDescription =>
      'اختياري وللقراءة فقط. يمكنك فصله متى شئت.';

  @override
  String get trustCalendarLockedTitle => 'التقويم لاحقًا';

  @override
  String get trustCalendarLockedMessage =>
      'سيعرض MaybeSitter ربط تقويمك بعد أن يكون قد أفادك فعلًا. ولن يطلب ذلك قبل هذا.';

  @override
  String get trustWhatWeKnowAction => 'ما الذي يعرفه MaybeSitter';

  @override
  String get trustWhatWeKnowSubtitle => 'اطّلع على كل ما يحتفظ به عنك';

  @override
  String get trustRevokeTitle => 'إيقاف كل شيء';

  @override
  String get trustRevokeDescription =>
      'يوقف الاقتراحات وبيانات الاستخدام والتقويم. تبقى التزاماتك.';

  @override
  String get trustRevokeConfirmTitle => 'إيقاف كل شيء؟';

  @override
  String get trustRevokeConfirmMessage =>
      'ستتوقّف الاقتراحات وبيانات الاستخدام وأي ربط بالتقويم. تبقى التزاماتك، ويمكنك إعادة التفعيل لاحقًا.';

  @override
  String get trustRevokedMessage => 'تم إيقاف كل شيء.';

  @override
  String get trustDeleteTitle => 'حذف كل شيء';

  @override
  String get trustDeleteDescription =>
      'يحذف التزاماتك وبيانات استخدامك. لا يمكن التراجع عن ذلك.';

  @override
  String get trustDeleteConfirmTitle => 'حذف كل شيء؟';

  @override
  String get trustDeleteConfirmMessage =>
      'سيؤدي هذا إلى حذف التزاماتك وبيانات استخدامك نهائيًا.';

  @override
  String get trustDeleteAcknowledge => 'أفهم أنه لا يمكن التراجع عن ذلك';

  @override
  String get trustDeletedMessage => 'تم حذف بياناتك.';

  @override
  String get trustUpdatedMessage => 'تم الحفظ.';

  @override
  String get trustLoadFailedTitle => 'تعذّر تحميل إعدادات الخصوصية';

  @override
  String get trustActionFailedMessage => 'لم يُحفظ التغيير. أعد المحاولة.';

  @override
  String get knowsTitle => 'ما الذي يعرفه MaybeSitter';

  @override
  String get knowsSubtitle => 'كل ما يحتفظ به عنك، في قائمة واحدة';

  @override
  String get knowsCommitmentsLabel => 'التزامات أكّدتها';

  @override
  String knowsCommitmentsCount(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count التزام',
      many: '$count التزامًا',
      few: '$count التزامات',
      two: 'التزامان',
      one: 'التزام واحد',
      zero: 'لا شيء',
    );
    return '$_temp0';
  }

  @override
  String get knowsRecommendationLabel => 'الاقتراحات';

  @override
  String get knowsAnalyticsLabel => 'بيانات الاستخدام';

  @override
  String get knowsCalendarLabel => 'التقويم';

  @override
  String get knowsOn => 'مفعّل';

  @override
  String get knowsOff => 'متوقّف';

  @override
  String get knowsConnected => 'مرتبط';

  @override
  String get knowsNotConnected => 'غير مرتبط';

  @override
  String get knowsNeverSectionTitle => 'لا يُجمَع إطلاقًا';

  @override
  String get knowsNoMessages => 'رسائلك الخاصة';

  @override
  String get knowsNoSensitive => 'استنتاجات عن صحتك أو مزاجك أو علاقاتك';

  @override
  String get knowsNoMedical => 'أي ملف طبي أو تشخيصي';

  @override
  String get knowsParticipantLabel => 'رمزك في التجربة';

  @override
  String get knowsParticipantNote =>
      'رمز عشوائي. ليس اسمك ولا يربطه شيء هنا باسمك.';

  @override
  String get pilotAccessTitle => 'دخول التجربة';

  @override
  String get pilotAccessMessage =>
      'أدخل الرمز الذي صدر لك لاستخدام نسخة التجربة.';

  @override
  String get pilotAccessTokenLabel => 'رمز التجربة';

  @override
  String get pilotAccessContinue => 'متابعة';

  @override
  String get pilotAccessValidating => 'جارٍ التحقق من الدخول';

  @override
  String get pilotAccessInvalidTitle => 'هذا الرمز لم يعمل';

  @override
  String get pilotAccessInvalidMessage =>
      'تحقق من الرمز الذي صدر لك ثم أعد المحاولة.';

  @override
  String get pilotAccessNotAllowlistedTitle => 'هذا الرمز غير موجود في التجربة';

  @override
  String get pilotAccessNotAllowlistedMessage =>
      'تعذّر على MaybeSitter إدخال هذا الرمز في التجربة الحالية.';

  @override
  String get pilotAccessRevokedTitle => 'تم إلغاء دخول التجربة';

  @override
  String get pilotAccessRevokedMessage =>
      'أُغلقت جلسة التجربة هذه. لم تعد الشاشات العادية متاحة لهذا الرمز.';

  @override
  String get pilotAccessDeletedTitle => 'تم حذف بيانات التجربة';

  @override
  String get pilotAccessDeletedMessage =>
      'تم حذف بيانات التجربة لهذا الرمز. سيبقى التطبيق مغلقًا لهذه الجلسة.';

  @override
  String get pilotAccessBackendUnavailableTitle =>
      'تعذّر الوصول إلى MaybeSitter';

  @override
  String get pilotAccessBackendUnavailableMessage =>
      'احتفظ بالرمز على هذا الجهاز وأعد المحاولة عندما تتاح الخدمة.';

  @override
  String get pilotAccessRuntimeConfigTitle => 'التجربة غير مهيأة';

  @override
  String get pilotAccessRuntimeConfigMessage =>
      'خادم التجربة مغلق احترازيًا لأن إعدادات التشغيل غير صالحة.';

  @override
  String get pilotAccessClearToken => 'استخدام رمز آخر';
}
