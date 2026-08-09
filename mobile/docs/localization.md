# Localization & Terminology Guide — Maybesitter Mobile

## Overview
The Maybesitter Mobile application supports three locales:
- **English (`en`)** — Default LTR
- **Arabic (`ar`)** — Modern Standard Arabic (الفصحى), RTL
- **Hebrew (`he`)** — Modern Israeli Hebrew, RTL

## Core Terminology Table

| Concept | English (`en`) | Arabic (`ar`) | Hebrew (`he`) |
| :--- | :--- | :--- | :--- |
| **Commitment** | Commitment | التزام | התחייבות |
| **Reminder** | Reminder | تذكير | תזכורת |
| **MUST** | MUST | ضروري | חובה |
| **SHOULD** | SHOULD | مستحسن | מומלץ |
| **NICE** | NICE | اختياري | רשות |
| **Today** | Today | اليوم | היום |
| **Tomorrow** | Tomorrow | غدًا | מחר |
| **Upcoming** | Upcoming | القادمة | הבאים |
| **Complete** | Complete | إكمال | השלמה |
| **Cancel** | Cancel | إلغاء | ביטול |
| **Delete** | Delete | حذف | מחיקה |
| **Postpone** | Postpone | تأجيل | דחייה |
| **Clarification** | Clarification | توضيح | הבהרה |
| **Review** | Review | مراجعة | בדיקה |
| **Save** | Save | حفظ | שמירה |
| **Retry** | Try Again | إعادة المحاولة | ניסיון נוסף |
| **Offline** | Offline | غير متصل | לא מחובר |
| **No Commitment Found** | Nothing Found | لم يتم العثور على التزامات | לא נמצאו התחייבויות |

## Locale Selection & Persistence
Language preference is configured via `AppSettingsNotifier` and persisted using `SharedPreferences`:
- `AppLanguage.system` (follows device locale, defaults to English if unsupported)
- `AppLanguage.en` (`en`)
- `AppLanguage.ar` (`ar`)
- `AppLanguage.he` (`he`)
