# QA audit plan, version 2

Date: 2026-11-12. This plan **replaces** `2026-11-12-qa-audit-plan.md` (v1).

## Why v1 was not enough

v1 read each feature's expected behaviour **from the code**, then checked whether the device does what the code says. That method cannot catch behaviour that is wrong by design.

The owner found such a defect himself: commitments whose time has passed stay on Today forever. The code does exactly that, so v1 would have marked it MATCH. 17 code auditors (Claude and Codex) read the lists and none flagged it.

The lesson: **what should happen must come from someone who has not read the code**, and every feature must be pushed through time and through its whole life, not only through its buttons.

## The method, as the owner set it

1. **A general plan** (this file): checks that apply to every feature.
2. **A specific plan per feature.** For each feature, an **external agent** is asked an **open, deliberately vague question** from the user's side, and must answer with **50–100+ cases** the tester has to verify.
   - The external agent is a different model from the testers: Codex `gpt-5.6-sol`, or agy for a tie-break.
   - It never sees the code, so its cases say what a user would expect, not what the code does.
3. **The test** is run against both the general plan and the feature's case list.
4. **A clean report** comes back.

## Part A: the general plan, applied to every feature

Every feature is checked through all twelve lenses below, on top of its own case list. Each lens says what is asked.

| # | Lens | What is asked of every feature |
|---|---|---|
| G1 | **Time and life cycle** | What happens after 1 minute, 1 hour, midnight, the next morning, 3 days, 3 weeks? Does every item reach an end state, or does something stay forever? What does the person see when its time has passed? (This lens alone would have caught the owner's finding.) |
| G2 | **Data volume** | Empty account; one item; a dense account (25+ items over past, present and future days); a very long title; many items at the same time |
| G3 | **Wrong or odd input** | Arabic, English, mixed, emoji, numbers in Arabic and Latin digits, very short and very long input, ambiguous times («الساعة 5»), dates that do not exist |
| G4 | **Failure** | Offline, server error, slow answer, a double tap, the app killed in the middle, a retry after a lost answer |
| G5 | **Limits and money** | Per-day and per-minute model caps, the monthly add-on budget, what the person sees when a cap is reached, and whether a refused action still spends |
| G6 | **Privacy and deletion** | What is stored; what leaves after deletion or sign-out; what shows on the lock screen, widget or notifications; another account never sees it |
| G7 | **Language and direction** | Arabic RTL in full and English LTR; switching language with items already scheduled (notifications in the old language) |
| G8 | **Accessibility** | AX5 text size, VoiceOver reading the main action and the result, colour not used alone for meaning |
| G9 | **Consistency across surfaces** | The same item looks the same on Today, the plan, the week, details, the widget, notifications and search, and changing it in one place changes it everywhere |
| G10 | **Undo and the person's control** | Every automatic change can be seen and undone; the copy is true (it says what really happens) |
| G11 | **Old data** | Items created by older versions (missing new fields) still work |
| G12 | **The person's intent** | Would a real person (student, entrepreneur, business owner) understand what happened and why, without help? |

## Part B: the specific plan per feature

### B1. Features (35)

The unit of testing is the **feature**, smaller than v1's units, so that no feature hides inside a big screen.

| ID | Feature |
|---|---|
| F01 | Language choice and switching |
| F02 | Sign-up, sign-in, password reset and verification |
| F03 | Onboarding: consent, routine, about you, notifications |
| F04 | Capture by text in chat («احكيها») |
| F05 | Capture by voice |
| F06 | Clarifying questions and the summary («هيك صح») |
| F07 | Sharing into the app from other apps (text, link, images, file, WhatsApp export) |
| F08 | Today list (order, groups, carried-over items, finished items) |
| F09 | Next-step card |
| F10 | Commitment details and editing |
| F11 | Postpone, including smart postpone slots |
| F12 | Done, drop and delete |
| F13 | **What happens when an item's time passes** (events, deadlines, tasks) |
| F14 | Daily plan (build, accept, edit, regenerate, morning plan) |
| F15 | Week plan |
| F16 | Plan tab: calendar view, free time, busy time from every source |
| F17 | Weekly fixed blocks and manual busy (lectures) |
| F18 | Device calendar read and write |
| F19 | Calendar links (ICS, Moodle) and their deadlines |
| F20 | Google connection (calendar, Drive) |
| F21 | Gmail reading (scan, monitor, «انضاف من إيميلك») |
| F22 | Goals and goal plans |
| F23 | Habits |
| F24 | Ideas / waiting on («Seeds») |
| F25 | Search |
| F26 | Memory («بيعرف عنك»), summary, translation, AI import |
| F27 | Proactive suggestions and questions |
| F28 | Watching and watches |
| F29 | Football |
| F30 | Reminders and hard reminders (Must) |
| F31 | Notifications and their taps |
| F32 | Widget |
| F33 | Places |
| F34 | Features «الميزات» and add-on budgets |
| F35 | Trust, privacy, export, sign-out and account deletion |

### B2. Getting each feature's case list from the external agent

The external agent receives **only** the feature's name and a two-line description written from the person's side, with no code and no screens. It is asked the same open question, in English, for every feature:

> "MaybeSitter is a phone assistant for students, entrepreneurs and business owners. It captures what they committed to and helps them do it. One of its features is: «<feature, two lines>». You are going to be the person who has to guarantee this feature never surprises or fails a real user. List between 50 and 100 situations a tester must check. Include situations over time (minutes, days, weeks), unusual input, failure, money and limits, privacy, Arabic and English, and anything a real person would expect but a programmer might forget. For each situation give: the situation, what the person does, and what the person should see or get. Do not assume how it is built."

Then:
- The answer is saved as `evidence/qa-audit-<sha>/cases/<F>.md`.
- A Claude reviewer removes duplicates and adds any of the twelve general lenses that the list skipped, **without deleting the agent's cases**.
- The final list is numbered `<F>.K<n>`.

### B3. Testing each case three ways

Each case is checked three ways:
1. **Expected:** what the case says the person should get. This is the oracle, and it is independent of the code.
2. **Code:** what the code does for that case, read with `file:line`, and covered or not by an existing test.
3. **Real:** what happens, run on the simulator or through the staging API with a real account.

Every case gets one verdict:

| Verdict | Meaning |
|---|---|
| **OK** | expected = code = real |
| **DESIGN GAP** | the code does what it was written to do, and that is not what a person expects. This is the class v1 missed |
| **BUG** | the code means to do the expected thing, but the real run differs |
| **TEST LIES** | an existing test is green on behaviour that fails the case |
| **NOT RUN** | with the reason: needs a real phone, Android, real push, owner action, etc. |

### B4. How cases are run

- **Through the API (scripted):** cases about data and server behaviour run as scripts against staging with QA accounts. This includes time-based cases, using past-dated items created through the API: a lecture "3 weeks ago", a deadline "yesterday".
  - The server clock cannot be moved, so "after 3 days" is tested by creating the item 3 days in the past.
  - This limit is written next to each such case.
- **On the simulator:** cases about what the person sees, driven by accessibility ID.
  - One device seat runs one feature at a time.
  - Each case has a screenshot.
  - Model-path cases are run 3 times.
- **Code only:** a case that cannot run anywhere (for example, 7 days of a real Google token) is judged from the code and marked as such.
- **A real phone:** cases that need one are listed for the owner's Redmi and marked NOT RUN until then.

## Part C: the report

**Path:** `evidence/qa-audit-<sha>/REPORT.md`, plus an Arabic summary.

1. **Header:** the commit, the staging revision, the build, the dates, the accounts used, and the model spend.
2. **One line per feature:** the number of cases and the counts of OK / DESIGN GAP / BUG / TEST LIES / NOT RUN.
3. **All DESIGN GAPs and BUGs**, by severity:
   - **S1:** data loss, a privacy or account leak, money spent wrongly, a crash, or a locked-out account;
   - **S2:** a main flow wrong;
   - **S3:** wrong with a workaround;
   - **S4:** cosmetic.

   Each entry has the case, the expected result, the code (`file:line`), the real result, and the evidence.
4. **Green tests that lie.**
5. **Everything not run, and why.** Nothing outside the report is claimed to work.
6. **Nothing is fixed during the audit.** The owner chooses what to fix from the report.

## Part D: staffing and order

At most 3 Claude agents at once on this machine, plus Codex. There is one device seat.

1. **Case generation:**
   - Codex answers the open question for all 35 features, a few at a time.
   - A Claude reviewer adds the general-lens cases.
   - Expect about 2,500 cases.
2. **Code and API pass:**
   - Claude agents take the features in groups. For every case they fill in "code" and, where it is scriptable, "real" through the API.
   - Codex reviews a sample of each group's verdicts.
3. **Device pass:** the device seat runs every case that needs the screen, feature by feature, starting with the features the owner uses daily: F08, F13, F04, F14, F09, F10–F12.
4. **Report.**

## Part E: what it costs and what the owner gives

- **Model spend:** device and API cases that reach the model are estimated at **$5–10** for the full run, because capture, chat and plan calls are run 3 times each. This needs the owner's yes before the device pass. Case generation runs on Codex, which costs no API money.
- **Time:** case generation and the code and API pass take about 2–3 days. The device pass takes about 4–6 days on one simulator. The report follows.
- **From the owner:**
  - the yes on spend;
  - QA accounts (already approved);
  - his Google account for F20/F21 (already given), with Google disconnect and account deletion forbidden while it is connected (#825);
  - a real phone session at the end for the NOT RUN list.
- **The audit is pinned to one commit.** The owner chose to deploy fixes as they are ready, so the audit runs on the commit staging serves when the case pass starts, and starts again if staging moves before the device pass ends.
