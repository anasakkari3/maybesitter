# Launch v1 closed test — daily runbook (UC-4.6b, #204)

Owner: **Anas Akkari**. Test period: **2026-10-28 (day 1) → 2026-11-10 (day
14)**. Exit report and Play production-access application: **2026-11-11**
(UC-4.7, #205).

**This file holds no personal data.** Testers are `T01`–`T20`, and the mapping
from a T-code to a person lives only in the owner's private roster (see
`docs/release/OWNER_TESTER_RECRUITMENT.md`) — never here, never in an issue.
If a name, an email address or a phone number ever appears in a diff to this
file, that is the incident, not a tidy-up. Nothing below is filled in for a
day that has not happened; an empty cell is an honest cell.

## What has to be true before day 1

| Prerequisite | Where it lives | State |
|---|---|---|
| Store accounts exist | OWNER-A2 (#158) | check the issue |
| Consoles, tracks, opt-in URL, first manual AAB | #331, `docs/release/CLOSED_TEST_TRACKS.md` | check the issue |
| Roster: ≥ 15 Android + 5 iOS, consented, by 10-26 | OWNER-A3 (#159), private sheet | check the issue |
| Track config: Play `alpha` ("Closed testing – Alpha"), `releaseStatus: draft`; TestFlight group "Closed test Oct–Nov 2026" | `mobile/eas.json`, `docs/release/CLOSED_TEST_TRACKS.md` | in the repo |
| Crash reporting with symbol upload | UC-4.4 (#180), `docs/operations/CRASH_REPORTING.md` | done; first real symbolicated crash is verified on the first track build |
| Cost and quota alerts | UC-4.5 (#181), `infra/cloudrun/ai-cost-alerts.sh` | done |
| In-card feedback flag | UC-2.R3 (#173), `POST /api/mobile/alpha/feedback` | shipped |

The 14-day clock counts **Play (Android) testers who opted in via the opt-in
URL and stayed opted in** for the latest 14 consecutive days. iOS testers are
valuable and do not count toward Google's number.

## 1. Daily triage — 30 minutes, 20:00 Asia/Jerusalem

In this order. The order is deliberate: a crash that deletes data matters more
than a typo, and the opted-in count is the number the whole exercise exists
for.

1. **Crashlytics** — new or regressed **fatal** issues since yesterday, plus
   crash-free sessions per platform per the definition in
   `docs/operations/CRASH_REPORTING.md` (`1 − fatals ÷ sessions`; sessions come
   from the Cloud Logging log-based metric counting requests with
   `X-App-Platform`). Cross-check Play Console → Android vitals and App Store
   Connect → Crashes. An unreadable stack means a symbolication problem — see
   §7 before anything else, because every later crash is blind until it is
   fixed.
2. **Play Console → Testing → Closed testing → Testers** — the **opted-in
   count**. Log it in §3. This is the number Google counts; apply §4.
3. **Play Console → Pre-launch report** — for any build uploaded since
   yesterday.
4. **TestFlight → Feedback** — screenshots and crashes submitted by iOS
   testers.
5. **Google Form responses** — the form from #331 (email collection is *do not
   collect*).
6. **In-card feedback flags** — Firestore console, collection-group query on
   **`alphaFeedback`** (flags live at `users/{uid}/alphaFeedback/{flagId}`,
   30-day retention). A flag is something a tester chose to send; read the
   category and the note, never go looking for who sent it.
7. **Billing and alert emails** — the UC-4.5 (#181) alerts for Gemini, Cloud
   Run and Firestore. An alert mid-test is a same-day decision, not an
   end-of-test surprise: log spend-to-date in §3.
8. **WhatsApp broadcast list** — replies to the cadence messages (§5).

Everything a tester reports becomes a GitHub issue if it is S1 or S2 (§2).
**Paraphrase. No tester identity, no screenshots showing personal data** —
the repository is public.

## 2. Severity rules

| Severity | Definition | Response |
|---|---|---|
| **S1** | Crash on launch · data loss · a reminder not firing · AI called without consent · a privacy leak · no way to sign in | Fix within 24 h and ship a new build (§6) |
| **S2** | A core flow broken, with a workaround | Fix in the next weekly build |
| **S3** | Cosmetic, copy or RTL polish | Batch before submission |

- One GitHub issue per S1/S2, labels: `launch-v1`, `track: quality`, plus the
  area label. Refer to testers by T-code only.
- **A tester-reported privacy problem is automatically S1**, and the relevant
  feature flag or kill switch is considered the same day. The recommendation
  kill switch is a value change, not a deploy
  (`MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true` via
  `gcloud run services update maybesitter-<env> --region europe-west1
  --update-env-vars ...` — the exact command and what it does and does not
  stop are in `docs/operations/V03_CLOSED_PILOT_RUNBOOK.md`). It stops
  suggestions; it never touches capture, reminders or saved commitments.
- Counsel has not yet approved measurement wording for testers (X9, option C —
  see `docs/release/OWNER_TESTER_RECRUITMENT.md`). Until then: the aggregate,
  no-user-id metrics above (crash-free sessions, counts) are what triage
  reads; do not go reading an individual tester's usage.

## 3. Daily log

One row per day, filled on the day, at triage time. **No gaps and no
backfilling from memory** — a day nobody ran triage is logged as `missed`
with the reason, because the exit report and Google's questionnaire both read
this table.

| Date (2026) | Day | Opted-in Android (Play) | iOS installs | Crash-free iOS | Crash-free Android | New S1 | New S2 | New S3 | Spend to date (₪) | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 10-28 | 1 | | | | | | | | | |
| 10-29 | 2 | | | | | | | | | |
| 10-30 | 3 | | | | | | | | | |
| 10-31 | 4 | | | | | | | | | |
| 11-01 | 5 | | | | | | | | | |
| 11-02 | 6 | | | | | | | | | |
| 11-03 | 7 | | | | | | | | | |
| 11-04 | 8 | | | | | | | | | planned build day (§6) |
| 11-05 | 9 | | | | | | | | | |
| 11-06 | 10 | | | | | | | | | |
| 11-07 | 11 | | | | | | | | | |
| 11-08 | 12 | | | | | | | | | |
| 11-09 | 13 | | | | | | | | | survey day (§5) |
| 11-10 | 14 | | | | | | | | | last day of the window |

## 4. Opt-in safety margin

- **Start with at least 15 opted-in Android testers.** Twelve is Google's
  floor; the margin is the whole point.
- **At 13:** message the inactive testers the same day (a personal message,
  not the broadcast list) and add a reserve from the OWNER-A3 (#159) list.
- **Below 12 on any day:** the 14-day clock restarts from the day the count is
  back at ≥ 12. Immediately move the production-application date in UC-4.7
  (#205) — it carries one week of slack before the ~11-25 submission — and
  tell the owner. Note the restart in the daily log; the table must show the
  dip, not hide it.

## 5. Engagement cadence

Google's production-access questionnaire asks about engagement. Two to three
lines of plain Levantine Arabic over the broadcast list, on these days.
**These are drafts: the owner approves every word before anything is sent** —
the same rule as the recruitment kit. Send nothing on other days; the product
is designed to interrupt less, and so is this list.

| Day | Date | Purpose | Draft |
|---|---|---|---|
| 1 | 10-28 | Welcome | «أهلاً فيك بتجربة MaybeSitter! التطبيق بعده ببدايته، فطبيعي تطلع مشاكل — إذا صار معك أي شي غريب ابعثلي هون، أو علّم على البطاقة من جوّا التطبيق. شكراً إنك معنا.» |
| 3 | 10-30 | Try voice capture | «جرّبت تحكي بدل ما تكتب؟ افتح التطبيق واحكي اللي عليك بالعربي — مثلاً "بكرة بدي أسلّم التقرير الساعة 5" — ورح يطلع لك اقتراح بتقدر تأكده، تحركه، أو تسقطه بوعي.» |
| 5 | 11-01 | Share into the app — **only if the UC-3.0 (#183) share build has shipped** | «إذا إجاك PDF أو صفحة فيها مواعيد، جرّب تعملها مشاركة لـ MaybeSitter — بيقراها وبيقترح عليك الالتزامات اللي فيها، وإنت بتقرر.» |
| 5 | 11-01 | Fallback if share has not shipped | «جرّب خطة بكرة: بالمسا افتح تبويب الخطة وشوف شو مقترح عليك — ما بيتغيّر شي إلا إذا أكدت.» |
| 8 | 11-04 | New build, Arabic release notes | «نزل تحديث جديد: [سطر أو سطرين عن اللي اتغيّر، من ملاحظات الإصدار]. حدّث التطبيق من نفس المكان اللي نزّلته منه، وخبرني إذا صار شي.» |
| 11 | 11-07 | Try connecting a calendar — **only if UC-3.1 (#185)/3.2 has shipped** | «إذا بدك، جرّب توصل تقويمك من الإعدادات — بصير التطبيق يشوف الأوقات المحجوزة عندك قبل ما يقترح.» |
| 13 | 11-09 | Three-question survey | «ثلاث أسئلة وبس: شو أكثر شي عجبك؟ شو شي لخبطك أو ما كان واضح؟ بتنصح فيه لحدى؟ جاوب بكلمتين، بيكفي.» |

The survey answers are paraphrased into the exit report's top-issues section —
never quoted with a name.

## 6. Builds

- **Planned build on day 8 (2026-11-04)** carrying whatever S3 work has merged
  (share, calendar, reminders), plus **S1 hotfix builds** whenever §2 demands
  one. A new closed build does **not** reset Google's clock, but testers must
  stay opted in.
- Every build goes to both tracks:

```
eas build -p android --profile production
eas submit -p android            # lands on the alpha closed track as a draft; promote in the console
eas build -p ios --profile production
eas submit -p ios                # then add the build to the "Closed test Oct–Nov 2026" group
```

- Release notes in **English and Arabic**, every build, both tracks.
- Log every build that reaches a track in the Release log in
  `mobile/README.md` (date, platform, version, EAS build number, profile,
  track, commit). A build nobody received is not a release.
- Before any build goes out: the release checks in
  `docs/release/CLOSED_TEST_TRACKS.md` ("What ready means"), and the day-1/8/14
  device pass in §8 if it falls on that day.

## 7. Reading a crash (UC-4.4, #180)

The full rules — what a report is allowed to contain, and why — are in
`docs/operations/CRASH_REPORTING.md`. The operational core:

- **Hermes frames arrive minified.** The matching source map is a **private
  EAS build artifact** under `build/sourcemaps/`, per build, never committed.
  Check the build number before symbolicating — the wrong map gives wrong line
  numbers, which is worse than none:

```
npx metro-symbolicate build/sourcemaps/ios.jsbundle.map < stack.txt
```

- **Missing iOS dSYM:** download it from the EAS build page or App Store
  Connect, then
  `Pods/FirebaseCrashlytics/upload-symbols -gsp ios/MaybeSitter/GoogleService-Info.plist -p ios <path-to-dSYMs>`,
  and confirm Crashlytics → Missing dSYMs is empty for the build.
- **Android arrives as obfuscated class names:** R8 minification is what
  produces the mapping file; it is on for release builds via
  `expo-build-properties`. If it looks off, suspect the build profile before
  the plugin.
- Crashlytics never carries a user id — `setUserId` is never called, and a
  test keeps it that way. Triage correlates crashes to *builds and moments*,
  not to people.

## 8. Device regression pass — days 1, 8 and 14

On one iPhone and one Android phone, with the current tester build:

- [ ] sign in with Apple, Google and email
- [ ] capture by text and by voice in Arabic
- [ ] share a PDF through the share extension / Android share intent (once the
      UC-3.0 (#183) build has shipped)
- [ ] AI consent on and off
- [ ] calendar connect (once shipped)
- [ ] a reminder fires
- [ ] delete account on a spare account (UC-1.5, #149)

A failure here is triaged by §2 like any other finding.

## 9. Exit report — fill in on 2026-11-11

Written into this section and committed. **No part of it is pre-filled:**
every number comes from the daily log above and the consoles, on the day, not
from memory. It must contain no personal data — T-codes only.

### 9.1 Opted-in history

Copy the daily log's Android opted-in column here (14+ rows, or more if §4
restarted the clock). The Play Console Testers tab is the corroborating
source.

### 9.2 Issues by severity

| Severity | Found | Fixed | Open on 11-11 |
|---|---|---|---|
| S1 | | | must be 0 |
| S2 | | | |
| S3 | | | |

### 9.3 Crash-free sessions, final 7 days (11-04 → 11-10)

| Platform | Crash-free sessions | Meets ≥ 99.0% |
|---|---|---|
| iOS | | |
| Android | | |

### 9.4 Top 5 user-reported issues

For each: what testers reported (paraphrased, T-codes only) and what changed
because of it (issue link).

1.
2.
3.
4.
5.

### 9.5 Test-period spend

Total ₪, from the billing console, with one line on anything the UC-4.5
alerts caught.

### 9.6 Play production-access questionnaire — ready answers

Draft the answers from the log, not from impression:

- **Recruitment:** how testers were found and consented (counts only — the
  #159 reporting format).
- **Feedback collection:** the channels in §1 and how often they were read.
- **Changes made during the test:** the builds in the release log and the
  issues in §9.2.
- **Intended audience:** adults with ADHD-related executive dysfunction /
  task-initiation difficulty — a research cohort, not a diagnosis (see
  `docs/strategy/CURRENT_PRODUCT_STRATEGY.md`).
- **Why it is ready:** the crash-free record in §9.3, zero open S1, and the
  regression passes in §8.

The last checkbox is in the console, not in this file: **Play Console shows
"Apply for production" enabled on or after 2026-11-11.**

## What Claude may and may not do here

May: keep this document accurate, draft messages for the owner to approve,
and count.

May not, and has not: invent a tester, a count, a crash number, a spend
figure, or a log row for a day that has not happened; hold the roster; send
any message; or close #204 — its acceptance criteria are fourteen real days,
and they have not happened yet.
