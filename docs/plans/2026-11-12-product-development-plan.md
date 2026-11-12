# Product development plan: one month (2026-11-13 → 2026-12-11)

Owner direction, 2026-11-12:
- **Who it is for:** the first phase is for **entrepreneurs, business owners and students**.
- **Directions:** all four:
  1. deepen the core;
  2. add-ons that sell;
  3. new context sources;
  4. new integrations.
- **Horizon:** one month.

This plan is **new product work**. Release plumbing such as purchases, builds, store kits and switching on features that are already built lives in `2026-11-12-release-readiness-plan.md`. The QA audit lives in `2026-11-12-qa-audit-plan.md`.

## Rules every feature here follows

- **It is built on what exists.** Each feature names the code it extends. Its first step is to verify those anchors on `main`, because the inventories are from a code read, not a run.
- **It ships behind a default-off flag and reaches staging first.** Production only happens when the owner releases it, recorded as an exception the way the proactive loop was (AGENTS.md §6).
- **Model output stays a proposal.** Nothing the model produces changes the person's data without their tap. The only exception is the owner's email self-reply rule, and it is not widened here.
- **Cost is decided before code.**
  - Every model call goes through the provider gate, with its own `purpose`, and is charged to a catalog feature (`lib/features/catalog.ts`).
  - The free tier stays at 40¢ a month at most.
  - A feature that needs more is an add-on.
  - Any paid measurement run is stated with its cost and waits for the owner's yes.
- **Quality is measured, not assumed.** A change to the capture or extraction prompts is checked on a labelled set before and after, with zero recall loss (the owner's "never harm quality").
- **The QA audit freezes staging until its device stage ends,** at around the end of week 2. Until then, verify features on the local backend with the Auth and Firestore emulators (memory: "Local backend needs auth emulator"). After that, each feature is deployed to staging and run on the simulator.
- **Each feature is one lane:** a builder, a reviewer on the other model, and the skills routed per `AGENTS.md`. See `2026-11-12-agent-team.md`.

---

## Direction 1: deepen the core

### P1. Promises to people and waiting on people
**For:** entrepreneurs and business owners, who live on follow-ups.

A business owner's day is "I told the client I'd send the quote Tuesday" and "I'm waiting on the accountant". Today the app captures the first as an anonymous task, and the second only as a seed. This feature does three things:
- capture extracts **who** a promise is to, or who the person is waiting on, as a plain name on the item;
- a **People** view groups the open items by person;
- a "waiting on" item gets an automatic **follow-up nudge** after N days, which is a proposal and not a message sent to anyone.

**Anchors to verify:**
- seeds already have "waiting" (`lib/services/mobile/seedService.ts`, #519);
- the capture contracts (`src/contracts/v1/captureContracts.ts`);
- the jobs tick for due items (`lib/jobs/internalJobs`).

**Cost:** extraction rides the existing capture call. The schema gains one field, and there is no new call.

**Gates:**
- The capture-prompt change is run against the capture labelled set before and after. That paid run of about 10–20¢ waits for the owner's yes.
- The names stay on the person's own data. Telemetry carries no content.

**Done when:**
- names are extracted on the labelled set with no recall loss on commitments;
- the People view and the nudge work on the simulator in Arabic and English.

### P2. Real durations and time-blocking in the day plan
**For:** students (study blocks) and business owners (meetings and deep work).

The plan draws every item at one fixed height (#738), and commitments have no duration or end time. `mobile/AGENTS.md` lists duration and end time as fields the backend does not return. This feature:
- gives commitments an optional duration, either extracted ("ساعتين دراسة") or picked;
- makes the plan builder use it when placing items into free time;
- draws real lengths on the timeline.

**Anchors to verify:**
- `durationMinutes` already exists in the capture and goal-plan contracts;
- `lib/services/dailyPlan/*` and `lib/planning/freeSlots.ts` (env-locked);
- `mobile/src/features/plan/PlanDay.tsx`.

**Cost:** none new.

**Done when:**
- a two-hour item takes two hours on the timeline and blocks that time in the plan;
- old commitments without a duration still read correctly (default the field in `normalizeStoredCommitment`; memory: "Legacy docs need normalization").

### P3. Weekly review
**For:** everyone; the strongest habit loop for entrepreneurs.

Once a week, on a day and hour the person sets (default Thursday evening), MaybeSitter shows:
- what got done;
- what slipped, and how many times;
- what is still waiting on people (from P1);
- one tap into "plan next week", which uses `plans/week`, already built.

A push notification opens it.

**Anchors to verify:**
- `src/features/plan/WeekScreen.tsx` and `plans/week`;
- `activity/summary`;
- push kinds in `lib/push/pushService.ts`, which gets a new kind, `weekly_review`;
- quiet hours.

**Cost:** deterministic by default. An optional one-paragraph summary would be charged to `assistant` and capped at one call a week.

**Done when:** the review opens from the push and from Today, its numbers match the activity log, and "plan next week" carries the slipped items over.

## Direction 2: add-ons that sell

### P4. Study and project plans, working back from a deadline
**For:** students (assignments and exams) and entrepreneurs (launches and proposals). Add-on `goal_plans`.

This joins two things that are built but not connected:
- the goal-plan engine (steps, durations, slots, approve, confirm);
- deadlines from ICS feeds such as Moodle, and captured deadlines.

A deadline gets **"make me a plan"**: steps scheduled backwards into free time before the deadline. The person approves them, and they are re-planned when time moves.

**Anchors to verify:**
- `lib/services/mobile/goalPlanService.ts` and `src/contracts/v1/goalPlanContracts.ts`;
- `lib/calendar/icsFeeds.ts` (deadlines are already proposals);
- the routes behind `MAYBESITTER_FEATURE_GOAL_PLAN`, which is unset everywhere.

**Before building:**
- set the flag on staging, only after the audit's A7 run;
- fix #807 and #806.

**Cost:** goal decomposition, charged to `goal_plans` (free 3¢, grant 30¢ a month).

**Done when:** a Moodle-style ICS deadline becomes an approved plan with timed steps on the simulator, and moving the deadline re-plans it.

### P5. Gmail: "people asked you something"
**For:** business owners. Add-on `gmail_reading`, the $4–5 tier.

Today the Gmail pipeline finds commitments the person agreed to. This feature adds the other half: **mail where someone asked the person for something and they have not answered**. Each one shows as a proposal: "Ahmad asked for the price list on Sunday; you haven't replied."

**Constraints:**
- It uses the same scan, triage and post-read filter. The verbatim evidence quote is kept and no bodies are stored.
- It never sends, drafts or labels mail. The scope stays `gmail.readonly`.

**Anchors to verify:** `lib/intelligence/m5aGmailScan.ts`, `emailTriage.ts`, `autoAdds.ts`, the observation store, and the SENT label check for "answered".

**Cost:**
- It rides the existing read, plus at most one classification field.
- It is measured on the owner's golden set. Triage rule 2 already reads replies.
- Staging only until the CASA / verification decision (#516).

**Done when:** on the golden set, the asks are found with the zero-miss rule, and answered threads are not flagged.

## Direction 3: new context sources

These are deferred by ADR-0004 (#594). **The owner's choice of this direction is the decision to un-defer the two sources below only.** The ADR's required tests come with them:
- no content in telemetry;
- pull separated from ingest;
- a disconnect cascade.

### P6. Holidays, work days and Ramadan
**For:** business owners scheduling around closures, and everyone in the region.

The app knows which days are holidays and half-days for the person's chosen calendars (Israeli public and Jewish holidays, Muslim holidays, Christian holidays). It also has an optional Ramadan mode that shifts the day's shape, and optional prayer times as light, movable busy time. Two effects:
- plans and reminders respect them, for example "tomorrow is a holiday, the offices are closed: move the bank errand?";
- Today shows a one-line day context.

**How:**
- Computed on the server with no external API and no cost.
- Node's full ICU covers the `hebrew` and `islamic-umalqura` calendars, plus a small, reviewed table for the Israeli rules that move dates.
- Prayer times use the MIT-licensed `adhan` library.
- **License check before adding any dependency.** `@hebcal/core` is GPL-2.0, so do not add it without the owner deciding.
- Do not compute this on the device, because Hermes lacks parts of `Intl` (memory: "Hermes Intl plurals").

**Anchors to verify:** the watcher and source framework (`lib/watchers/*`), busy blocks (`lib/calendar/busyBlocks.ts`) and the day plan.

**Done when:**
- the dates match an official list for 2026–2027;
- a plan built on a holiday proposes moving office-hours errands;
- every source switches off from Settings.

### P7. University calendars in two taps
**For:** students.

ICS feeds work, but students do not know where their Moodle feed URL is. This feature adds:
- a picker of supported universities, with step-by-step instructions for each one's Moodle "export calendar" URL;
- exam-period awareness, so the plan protects study time during exam weeks.

**Anchors to verify:** `src/features/calendarFeeds/CalendarFeedsScreen.tsx`, `lib/calendar/icsFeeds.ts` (5 feeds, KMS-sealed URLs), and onboarding.

**Owner decision:** the first list of universities.

**Cost:** none.

**Done when:** a student goes from onboarding to deadlines on Today with one pasted URL, on the simulator, in Arabic.

## Direction 4: new integrations

### P8. Outlook / Microsoft 365 calendar (busy time)
**For:** business owners on Microsoft.

This mirrors Google: a server-side OAuth connection reads **busy time only**, with no titles and no bodies, through Graph `getSchedule` / free-busy. It feeds the same busy blocks that plans and clash checks use. A disconnect cascades and revokes.

**Anchors to verify:**
- `lib/integrations/microsoftGraph/adapter.ts` is a normalizer only, with no transport (memory: "Providers have no transport");
- the Google pattern to copy: `googleConnectService`, `googleCalendarBusy`, KMS-sealed tokens.

**Owner action:** register an Azure app (free), and decide on publisher verification.

**Done when:**
- a Microsoft account connects, and its busy time appears and is respected by the plan;
- disconnect removes it;
- the enumerating guard tests are updated (memory: "six tests break on any new provider").

### P9. Notion tasks import (stretch)
**For:** entrepreneurs who already plan in Notion.

The person picks one Notion database. Its open items that have dates come in as **proposals**, never as direct commitments. The sync is one-way and manual ("refresh"), with no background polling in this month.

**Anchors to verify:** `lib/integrations/notion/adapter.ts` (normalizer only), and the share intake proposal path.

**Owner action:** create the Notion integration (free).

**Done when:** a picked database's dated tasks show up for review, and disconnect removes the token.

This is a **stretch** item: it starts only if P1–P8 are on track at the end of week 3.

---

## The month

| Week | Dates | Build (at most 3 agents at once, shared with the audit) | On staging |
|---|---|---|---|
| 1 | 11-13 → 11-19 | Short spec per feature, approved by the owner (P1–P8). Build P2 durations and P3 weekly review. P6 data research and license check | No; the audit freezes staging. Use local emulators |
| 2 | 11-20 → 11-26 | Build P1 people and follow-ups (with the capture before/after run) and P7 university picker. P4 starts after the audit's A7 run | No, until the audit's device stage ends |
| 3 | 11-27 → 12-03 | Build P6 holidays, P8 Outlook busy time and P5 Gmail asks | Deploy P2, P3, P1, P7 and P4 to staging; simulator run per feature |
| 4 | 12-04 → 12-11 | P9 if on track. Finish and review everything. Release proposals to the owner, one per feature | Deploy P6, P8 and P5; simulator run; month report |

## What the owner decides, and when

| When | Decision |
|---|---|
| Week 1 | Approve each feature's one-page spec, including names and copy for the People view and the weekly review day |
| Week 1 | Holiday calendars to include, and whether a GPL dependency is acceptable (default: no) |
| Week 2 | The university list (P7). The paid capture before/after run (P1, about 10–20¢) |
| Week 3 | Azure app registration (P8) and the Notion integration (P9) |
| Week 4 | Which features go to production, each as a recorded exception |

## Out of scope this month

Each needs money, an evidence gate or more than a month:
- Apple Watch;
- Todoist;
- sending or drafting mail;
- Outlook mail;
- birthdays from contacts;
- live events;
- packs UI;
- an on-device model.
