# Closed-test recruitment — owner checklist (OWNER-A3, #159)

**OWNER / PRIVATE-DATA ACTION.** Recruitment means contacting real people and
holding their names and email addresses. Claude has not invented a tester, has
not collected a contact, has not sent a message, and no personal data appears
anywhere in this repository.

What is prepared here is everything that is *not* personal data: the roster's
shape, the words to send, the consent to obtain, and the format for reporting
progress without publishing anybody.

## What the numbers have to be, and why

**At least 15 Android and 5 iOS testers, consented, by 2026-10-26.**

Fifteen Android is not padding. Google requires **12 testers opted in for 14
consecutive days** on a personal Play account created after 2023-11-13 (#204).
Twelve is the floor, and some fraction of anyone recruited will install late,
uninstall, or change phones — so the target is the floor plus a margin, and the
margin is the whole point.

Fourteen *consecutive* days is the part that punishes a slow start. The clock
does not begin when somebody accepts; it begins when they are actually opted
in. A tester recruited on day three costs three days off the end.

## The roster lives in a private sheet, never in this repository

Columns, so the sheet is ready to create:

| Column | Notes |
|---|---|
| Name | first name is enough |
| Platform | `android` / `ios` |
| Language | `ar` / `he` / `en`, the language they said they'd use |
| Knows the founder | `yes` / `no`, their own answer from the sign-up form |
| Source · arm | the `source` code and `v` arm of the link they came from (see the kit) |
| Outside network | `yes` only if "knows the founder" is `no` **and** the source is not `wa` or `warm` |
| Contact | the address the invite went to |
| Google account email | **Android only.** Play needs the exact Google account; a different address silently fails to grant access |
| Invited on | date |
| Consented on | date, from their own reply |
| Opted in on | the date they actually joined the track — this is the one the 14 days count from |
| Still in | yes/no, checked weekly |
| Notes | anything they reported |

`.gitignore` does not need a rule for this because the file must not be created
in the repository at all. If a roster ever appears in a diff, that is the
incident, not a tidy-up.

## The invitation

Short, honest about the burden, and explicit that leaving is fine. Israeli
Hebrew and Levantine Arabic speakers are the audience; English is the fallback.

**The current drafts live in
[`docs/marketing/TESTER_RECRUITMENT_KIT.md`](../marketing/TESTER_RECRUITMENT_KIT.md):**
Arabic (written first), Hebrew (awaiting native review, #335) and English, each in both
message-test arms, plus the warm-lead and student-union texts and the link and
source-code convention. They follow the approved claims policy. The owner approves every
word before anything is sent.

The original English draft is kept below for reference. Use the kit's version: this one
says "no nagging", which the claims policy replaces with "designed to interrupt less".

> **Subject:** Would you try MaybeSitter for two weeks?
>
> I'm building MaybeSitter — you say or type something you've committed to, and
> it turns it into a reminder you can move or drop on purpose. No "overdue", no
> nagging.
>
> To put it on the stores I need a small group using it for **14 days in a
> row**. That's the whole ask: install it, keep it installed, use it when it's
> useful. There's nothing to fill in and no meetings.
>
> Two things you should know before saying yes. It's early, so things will
> break. And on Android I'll need the **Google account email** you use on your
> phone, because that's how Google grants access — I'll only use it for that.
>
> You can stop any time and I won't ask why. If you'd rather not, just say so —
> genuinely no hard feelings.

**Arabic and Hebrew versions are the owner's to approve.** The kit's drafts
are a starting point, not a send-ready text: an invitation in somebody's own
language, from a friend, that reads as machine-translated does more harm than an
English one.

## Consent, before anything is recorded

Their reply must show they understood three things. A "yes" to a message that
did not say them is not consent to them:

1. They are installing a **pre-release** app that will have problems.
2. On Android, their **Google account email** is used to grant access.
3. They may **leave at any time**, and nothing is owed.

> **4. PLACEHOLDER: NOT FINAL, BLOCKED ON COUNSEL (X9, option C).**
> The owner ruled (2026-09-23) that usage of the pre-release build may be
> measured for the closed test under a research consent, **only if counsel
> approves the exact wording and its relationship to the in-app analytics
> setting.** No wording is proposed here on purpose. Until counsel approves:
> do not add measurement wording to any message, do not treat any reply as
> consent to measurement, and do not read any tester's usage data beyond what
> they choose to show you. Public users stay on option A: analytics only
> after the in-app consent.

Record the date of their own words. Do not record the words.

## Reminders

- **Day 1 after the track opens** — to anyone who consented but has not opted
  in. This is the highest-value message in the whole sequence: the 14 days
  count from opt-in, and every day of delay is a day off the end.

  > The test track is open — here's the link. Once you install, the 14 days
  > start counting for you.

- **Day 7** — to everyone still in.

  > Halfway. Nothing needed from you, just keep it installed. Anything odd so
  > far?

- **Day 13** — only if somebody's install looks gone.

  > One more day. If MaybeSitter came off your phone that's completely fine —
  > could you just tell me, so I know the count?

## Reporting progress without publishing anybody

Comments on #159 use **counts only**. No names, no addresses, no initials:

```
Recruitment, 2026-10-2X
  invited      android N · ios N
  consented    android N · ios N
  opted in     android N · ios N
  still in     android N · ios N   (day X of 14)
  at risk      N        (consented, not opted in)
  outside net  N        (see the roster column)
  by arm       a N · b N · none N
```

`at risk` is the number that decides whether to recruit more, and it is the
only one worth acting on before day 14.

## What Claude may and may not do here

May: keep this document accurate, and count.

May not, and has not: invent a tester, scrape or collect a contact, send any
outreach, or put a name or an address into this repository or an issue.

## Status

`#159` stays **open**. Recruitment is the owner's, and it cannot start before
the Play Console account exists (#158), which is itself deferred on payment.
