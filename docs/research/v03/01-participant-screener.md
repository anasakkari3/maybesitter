# 01 — Participant screener

Issue #54. Runs at first contact, before any interview is booked. 5–7 minutes by message or call.

The screener is deliberately **generous**: it decides who is worth 45 minutes, not who counts as
evidence. The interview and [the coding rubric](10-coding-rubric.md) are the strict gate. Expect
roughly a third of screener-qualified candidates to fail behavioral coding afterwards — that is the
screener working correctly, not a recruiting failure.

Open the recruitment tracker row **before** asking S1, so a candidate who drops out mid-screener is
still counted in the funnel denominator.

> **`CAMPUS_ETHICS_STATUS = unresolved`.** Do not screen candidates reached through
> `source_channel=university_board` or `student_group` until Anas has determined whether the
> institution requires ethics approval or notification. Bilingual students reached by other routes,
> and the whole commercial cohort, are unaffected. This kit states no legal conclusion either way.

### Sensitive-data minimization

This study does **not** collect diagnosis status, and does not require one. There is no field for
it, no screener question asks for it, and no gate in #54, #55, #56, or #57 requires it. Eligibility
rests on observable executive-function and intent-to-action difficulty plus historical behavior —
what slipped, how often, what it cost, what they tried, what they paid for.

If a candidate volunteers a diagnosis, acknowledge it briefly and record nothing. Do not ask whether
they are diagnosed, whether they are medicated, whether they have been assessed, or whether they are
"officially" anything. A self-described pattern is the eligibility signal; a clinical label is data
this study has no use for and no business holding.

---

## Script

> Thanks for the reply. Before we book anything I have about five minutes of questions to check
> whether this study is a fit. There are no right answers, and nothing here is a test. I'll be
> asking about what actually happened in your last few weeks, not about any product.
>
> If we do the interview it's 45 minutes and it's paid — 75 shekels, the same for everyone, whatever
> your answers turn out to be.

### S1 — Age (hard gate)

> Are you 18 or older?

- **No → stop immediately.** Record `screener_outcome=not_qualified`, `adult_confirmed=no`. Delete
  everything else about them. Do not ask their age.
- Yes → `adult_confirmed=yes`.

### S2 — Interview language and logistics

> Which language would you rather do this in — English, Arabic, or Hebrew? And is a 45-minute call
> in the next two weeks realistic for you?

Operational only. Sets `interview_language` on the interview row later. A candidate who cannot
commit 45 minutes is `screener_outcome=declined`, not `not_qualified` — they are not evidence about
the problem.

### S3 — Frequency of slips (behavioral count)

> Thinking about the last four weeks specifically: how many times did an important commitment slip —
> you forgot it, missed it, or knew about it and still couldn't get started?

Offer the buckets only if they stall: `0` / `1` / `2–3` / `4 or more`.

| Answer | `screener_pain_signal` |
| --- | --- |
| 4 or more | `yes` |
| 2–3 | `yes` |
| 1 | `no` |
| 0 | `no` |

Do not react to the number. Do not say "only?" or "wow".

### S4 — The most recent one, and what it cost

> Take the most recent one. What was it, and what did it actually cost you?

You need one concrete consequence — money, a missed deadline, a rescheduled appointment, a late fee,
an hour lost redoing something, someone else inconvenienced, a strained relationship. "It was
stressful" on its own is not concrete; probe once with *"and what happened because of that?"* then
move on either way.

Write two lines in the note. Do not code it yet — the interview establishes cost properly.

### S5 — Current workflow

> What are you using right now to keep track of this kind of thing?

Map to codes for the interview row: `paper`, `calendar`, `todo_app`, `chat_ai`, `notes`, `memory`,
`other`. Multiple allowed. "Nothing, I just remember" is `memory`, not a non-answer.

### S6 — Payment history (commercial cohort gate)

> In the last twelve months, what have you paid for that was meant to help with this? Apps,
> subscriptions, a coach, a course, a planner — anything at all, including things you paid for once
> and abandoned.

Counts as paid behavior: any paid app, subscription, coaching, tutoring, course, or planning product
bought for organisation, focus, or time management. Does not count: employer-provided tools, free
tiers, or things bought for someone else.

### S7 — Commercial cohort self-identification

> Some people describe an ongoing pattern here rather than an occasional bad week — persistent
> trouble starting tasks, executive function, ADHD-type overwhelm. Is that a description you'd
> apply to yourself?

**Self-identification only.** Never ask whether they are diagnosed, assessed, or medicated. If they
volunteer a diagnosis: *"Thanks — I'm not collecting anything medical, so I'll just note that you
identify with the pattern."* Then write nothing about it.

What qualifies here is the described pattern of executive-function or intent-to-action difficulty,
corroborated by the behavioral history in S3–S6. A diagnosis neither qualifies nor disqualifies
anyone, and is not recorded either way.

### S8 — Fast-research cohort

> Are you currently studying at a university or college in Israel, and do you use both Arabic and
> Hebrew during a normal week?

Both halves must be yes.

### S9 — Consent to proceed, and the separate pilot question

> Two separate things, and you can say yes to one and no to the other with no consequence:
>
> 1. Are you willing to do the 45-minute interview? I'll read a short consent statement at the start.
> 2. Separately — if we later run a small closed test of an early tool, may I contact you about it?
>    That is a different decision, it is not part of this interview, and saying no changes nothing
>    about today.

Record them in two different cells. `pilot_contact_consent_recorded` is never inferred from
willingness to be interviewed.

---

## Qualification criteria

A candidate is `screener_outcome=qualified` when **all** of these hold:

1. `adult_confirmed=yes` (S1).
2. `screener_pain_signal=yes` (S3 ≥ 2 in four weeks).
3. They gave at least one concrete consequence at S4.
4. They meet **exactly one** cohort definition below.
5. They agreed to the interview at S9.

Otherwise:

| Situation | `screener_outcome` |
| --- | --- |
| Under 18 | `not_qualified` |
| Fails S3 or S4 | `not_qualified` |
| Meets no cohort definition | `not_qualified` |
| Willing but unavailable, or stops replying to scheduling | `declined` |
| Explicitly refuses the interview | `declined` |
| No reply within 7 days of the second message | `no_response` |

`declined` and `no_response` still stay in the tracker. Dropping them inflates the funnel and hides
recruiting bias.

## Cohort tagging

Every participant carries **exactly one** cohort for the whole study. It is fixed at screening and
never changed afterwards, because changing it after coding lets the analyst move a participant into
whichever cohort improves the number.

### `commercial` — ADHD / executive-function commercial cohort

All three:

- Adult who **self-identifies** with persistent task-initiation difficulty, executive dysfunction,
  overwhelm, or decision fatigue (S7 yes). Self-identification only — no diagnosis is asked for,
  required, or recorded.
- **Has paid** for a related tool, service, coaching, or course in the last 12 months (S6 yes).
- Not a student recruited through the campus channels below.

The paid-behavior requirement is structural: `lib/research/v03BehavioralResearch.ts` rejects a
commercial-cohort interview row with `paid_for_related_tool=no`. If someone self-identifies but has
never paid for anything, they are **not** commercial-cohort. Tag them `fast_research` only if they
also meet that definition; otherwise `not_qualified`. Record the count of such candidates — a large
number is itself a finding about willingness to pay.

### `fast_research` — Arabic/Hebrew bilingual student fast-research cohort

Both:

- Adult (18+) currently enrolled at a university or college in Israel.
- Uses both Arabic and Hebrew in a normal week (S8 yes).

Paid behavior is not required and is expected to be rarer. That asymmetry is the point of the
segmentation, and it is why an overall pass driven by this cohort is not market evidence.

### Overlap and edge cases

| Case | Rule |
| --- | --- |
| Meets both definitions | Tag by the channel that recruited them (`source_channel`). Record the overlap count in the #54 comment as a limitation. |
| Bilingual student who pays for tools | Still `fast_research` if recruited via a campus channel. Do not promote them to `commercial` to hit the 15-interview minimum. |
| Non-student bilingual adult | `commercial` if S6 and S7 pass; otherwise `not_qualified`. |
| Works on, invests in, or advises MaybeSitter | Excluded entirely. Not a tracker row. |
| Close friend or family of the researcher | Allowed, `source_channel=personal_network`, capped at 20% of the sample. |

## After the screener

- Qualified → send [the privacy explanation](04-privacy-explanation.md), book the slot, leave
  `linked_interview_id` empty until the interview happens.
- Not qualified → thank them with message **R6** in
  [02-recruitment-messages.md](02-recruitment-messages.md). Do not explain which criterion they
  missed; it teaches the next candidate what to say.
- Either way, the tracker row stays.
