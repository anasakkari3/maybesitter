# Public claims policy

Status: **approved by the owner, 2026-09-23** (decisions X1–X15, including the X9 ruling
and the four review edits). Applies to every public surface: the website, store
listings, social posts, press, tester invitations, the pitch deck, demo videos and the
GitHub repository description.

Positioning source: the owner-approved Product Marketing Context,
`.agents/product-marketing.md` at the project root (outside this repository).

Rule of thumb: **if you are not sure, a claim moves one column to the right.** Allowed →
qualified → forbidden.

`site/check-links.sh --local` fails when a forbidden phrase appears on the website. It
checks strings only. It does not replace reading this page.

## Positioning, as decided

- Category: **planner & reminders**. "AI" is how capture works, never the category (X1).
- The mechanism line is an **open experiment**. Arm A is "No overdue pile." and arm B is
  "Say it once. It lands in your day." Until one wins, the interim line is "A calm planner
  and reminders app, in Arabic, Hebrew and English."
- Availability: **Israel only** (X4). Arabic-speaking students are an ICP *hypothesis*, not
  a fact. Never "the app for Arab students".
- Price: **free during early access** (X11). Nothing else about pricing.
- Surface: frozen to the v1 core job (X13): capture, confirm, see it in your day, get
  reminded, resolve it.

## Allowed now

| ID | Claim | Basis |
|---|---|---|
| A1 | "A planner and reminders app" | X1 |
| A2 | "A captured commitment is saved only after you confirm it" | Confirm-before-save, simulator-verified (RC `e4e0c7ae`) |
| A3 | "AI features run only after you say yes. Say no and it still works with simple rules" | AI consent is enforced on the server (#161); rules-only mode exists |
| A4 | "Free during early access" | X11 |
| A5 | "Coming to the App Store and Google Play in Israel" | X4, #205 |
| A6 | "No ad tracking" | Store declarations: tracking "No" for every data type |
| A7 | "Built without an 'overdue' state: things are done, moved, or dropped on purpose", as a **design** statement | Product design (`obWelcomeCard2`, the #383 rule) |
| A8 | "Type it the way you'd say it" | Text capture is simulator-verified |
| A9 | "Arabic and English interface" | Language gate and RTL (visual) |
| A10 | "We're early. Help us test it" | True |

## Allowed only with a qualification

| ID | Claim | Required qualification now | Unlocks when |
|---|---|---|---|
| Q1 | Unfinished things "move with you" (as behaviour) | Design intent only ("built so that…") | The #383 carry-over is verified on the release build on a physical device |
| Q2 | "It lands / shows up in your day" | Means the Today list at its time. Never "around your calendar" | Calendar claims: the device calendar busy-read is verified on a device |
| Q3 | Voice: "say it out loud" | No microphone imagery, no voice claims. "Say" in arm B is figurative, and the page explains "type it" | Voice verified on a device in ar/he/en |
| Q4 | Understands mixed languages or dialect | Only "type in the language you think in" | Gemini evaluations on real Vertex (#330) and a code-switch benchmark. Never "first" or "best" |
| Q5 | Reminders: "reminds you before it's due" | Always add **"when notifications are enabled"** | The contextual permission ask is shipped (UI/UX lane) and delivery is verified on a device. Never "at the right time" |
| Q6 | "Delete your account and data from inside the app" | Also offer the request route (the `/delete-account` page) | In-app deletion verified on a device |
| Q7 | "Hebrew interface" / Hebrew marketing copy | Hebrew pages carry a native-review flag and are not deployed before #335 | Native Hebrew review done |
| Q8 | Survey numbers ("most misses aren't forgetting") | Always "small survey, 41 people, mostly students, directional" | Never unqualified |
| Q9 | "Plan your day" | "You can build a plan for today" (on demand) | Never "AI plans your day for you" |
| Q10 | "See, edit and delete what it keeps" | This wording only. Never "it learns you" | Memory verified on a device after the adaptive labels are removed (X5) |
| Q11 | "Your data is stored in the EU" | Only the exact wording of the published privacy policy | Region confirmed for Firestore, Cloud Run and Vertex |
| Q12 | "Usage analytics only if you turn them on" | True under X9 option A (the public default). Analytics events are **pseudonymous**, never "anonymous" | Rewritten only if counsel approves option B and the disclosures change |
| Q13 | The $5,000 accelerator funding | Only if the program's terms allow it, with the program **named accurately**, and **never** as evidence of traction or product-market fit. If the terms are unknown, leave it out | X14 |
| Q14 | "For people who study and work" | Audience framing only. No "used by students at [university]" | Only real, consented usage facts |
| Q15 | "One small next step when something feels too big" | Not public | X7: #329 live, consent asked in context, and evidence |
| Q16 | Widget, Must reminders that ring | Not headline claims. Feature lists only after verification | Device verification (#203, #197) |
| Q17 | "Designed to reduce pressure" / "designed to interrupt less" | Present it as a design choice still being tested. There is no user proof yet | Closed-test evidence |

## Forbidden

| ID | Claim | Why |
|---|---|---|
| F1 | "Personal AI chief of staff", "your personal AI", "AI assistant" as the category | X1. Highest expectation risk; puts us against Meta Muse, Gemini, Toki |
| F2 | "Manages your life", "knows you", "learns everything about you" | Strategy §13; not true |
| F3 | "Never forget again" | Contradicts the evidence (forgetting is the minority case) |
| F4 | Any ADHD, medical or therapeutic claim | Strategy §3/§13; health-claim risk |
| F5 | Reads your messages or email; Gmail, Outlook, Todoist, Notion or WHOOP connections | No transport or OAuth route exists; #516 open |
| F6 | Google Calendar sync, Moodle/ICS feeds, share from WhatsApp, reads PDFs or syllabi | No route (#187) or behind a flag that is off |
| F7 | Goals, watchers, "keeps an eye on things for you", acts or books on your behalf | Not user-facing; X13 |
| F8 | Financial insights, football fixtures, readiness, packs | X13 |
| F9 | Ratings, reviews, testimonials, user counts, retention figures | None exist. No `aggregateRating` or review schema either |
| F10 | "First / only / best Arabic AI planner" | Unverifiable; competitors support Arabic |
| F11 | "Free forever", "Pro", any price or tier | X11 |
| F12 | "Anonymous analytics", "we collect nothing", "100% private", "end-to-end encrypted" | Analytics events are keyed to the account; crash reports are collected |
| F13 | "No notifications" / "never interrupts" | Reminders exist; the claim is "designed to interrupt less" |
| F14 | Availability outside Israel | X4 |
| F15 | Screenshots or video of features that are flag-off or unverified, or AI-redrawn Arabic UI | The same claims, shown instead of said |

## Privacy wording (X9, 2026-09-23)

- Public default is **option A**: product analytics only after the in-app consent. It is
  off by default.
- Analytics events are **pseudonymous** (linked to the account). Never call them anonymous.
- Service records are **not** turned into analytics for people who did not consent, until
  counsel approves option B and the disclosures are updated.
- Crash reporting runs in released builds, is separate from the analytics setting, and is
  not linked to the account. Say so plainly.
- The closed-test research consent (option C) is **not final legal text** until counsel
  approves the wording.
