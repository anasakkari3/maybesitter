# 09 — Evidence codebook

Issue #54. The definition of every coded value. Use it with
[the coding rubric](10-coding-rubric.md), which covers the judgement calls this document leaves open.

Every example below is **illustrative and invented** to show how a code is applied. None of it is
interview data. No example may be copied into a tracker.

The authoritative definitions are in `lib/research/v03FieldIntake.ts` (tracker layer) and
`lib/research/v03BehavioralResearch.ts` (frozen coded schema). If this document and those files
disagree, the files win.

---

## Interview evidence tracker fields

### `interview_id`

Pseudonymous code, `^[a-z0-9][a-z0-9_-]{2,63}$`. Use a stable sequence: `int-001`, `int-002`.
Assigned before the call. Never reused, never reassigned after a withdrawal.

### `sample_inclusion`

| Value | Meaning |
| --- | --- |
| `sample` | Counts toward the 30–40 window and every denominator |
| `rehearsal` | Practice interview. Excluded from the coded artifact and from all rates |

Rehearsals exist so the first real interview is not the one where you discover the guide is too
long. Two is usually enough. A rehearsal can never be promoted to `sample` afterwards.

### `cohort`

`commercial` or `fast_research`. Fixed at screening by
[the screener's cohort rules](01-participant-screener.md#cohort-tagging). Never changed after the
interview. A `commercial` row with `paid_for_related_tool=no` is rejected by the schema.

### `interview_language`

`en` | `ar` | `he` | `mixed`. The language the interview was actually conducted in. `mixed` when the
participant switched languages during the interview — common and expected in the bilingual cohort.
Operational only; it does not enter the coded artifact.

### `cohort_eligibility_confirmed`

`yes` only. Confirms the screener's cohort criteria were actually checked with this person rather
than assumed from the channel they came through. Required to code the row.

### `occurred_at`

UTC ISO timestamp, `2026-09-14T09:00:00Z` or with milliseconds. The interview date, not the coding
date.

### `research_consent_recorded` / `adult_confirmed`

`yes` only. Both come from C8 in [the consent script](03-consent-script.md), answered aloud. A `no`
means the interview did not happen and there is no row.

### `past_behavior_example`

**Definition.** The participant described at least one specific commitment that slipped, with enough
detail to place it in time and to say what it was.

| Code | When |
| --- | --- |
| `yes` | A specific event, roughly dated ("two weeks ago", "the Tuesday before last"), identifiable as a particular thing |
| `no` | Only generalities: "I forget things all the time", "it happens constantly", "all the usual stuff" |

*Illustrative `yes`:* "The car insurance renewal — I had the email from mid-August and I did it on
the last day, in a panic, on my phone."
*Illustrative `no`:* "Honestly it's just a general state of chaos."

A specific event the participant cannot place in time at all is still `yes` if it is clearly one
identifiable event.

### `recurring_weekly_pain`

**Definition.** Slips of this kind happen at least weekly, evidenced by examples or by a frequency
count the participant gave without prompting.

| Code | When |
| --- | --- |
| `yes` | Four or more occurrences in the last four weeks, **and** at least a second example beyond the main one |
| `no` | Fewer than four, or a claim of frequency with no second example |

*Illustrative `yes`:* "That's probably twice a week. Last Thursday it was the pharmacy, and the week
before I missed a callback I'd promised."
*Illustrative `no`:* "It's constant." — with no second example when asked at 3.2.

Weekly is the bar because #54 says weekly. Monthly recurring pain is real and is coded `no`; say so
in the note rather than rounding up.

### `concrete_cost`

**Definition.** At least one consequence that can be stated as a fact rather than a feeling.

Counts: money paid or lost; a deadline missed; an appointment rescheduled or forfeited; time spent
redoing something; another person materially inconvenienced; an opportunity lost; a documented
relationship or trust consequence they described concretely.

Does not count, on its own: stress, guilt, shame, anxiety, "feeling behind", general dissatisfaction.

| Code | When |
| --- | --- |
| `yes` | At least one factual consequence, attached to the specific event |
| `no` | Only affect, or "it worked out fine", or a cost you had to supply for them |

*Illustrative `yes`:* "€40 late fee, and I had to take an hour off work to sort it out."
*Illustrative `yes`:* "My brother had to drive over and do it instead of me."
*Illustrative `no`:* "I felt awful about it for days." (Feeling only — probe once, then `no`.)

The three fields above form the primary metric and are the ones double-coded.

### `current_workflows`

Pipe-separated list, at least one value.

| Code | Means |
| --- | --- |
| `paper` | Notebook, planner, sticky notes, whiteboard |
| `calendar` | Any calendar app used for commitments |
| `todo_app` | Dedicated task manager — Todoist, Things, Reminders, Trello |
| `chat_ai` | A chat assistant used for planning or tracking |
| `notes` | A general notes app — Notes, Keep, Notion, a text file |
| `memory` | Unaided memory, explicitly ("I just remember") |
| `other` | Anything else — code it and describe it in the note |

Code what they **use**, seen or credibly described, not what they have installed. An app opened
twice this year is not a workflow; mention it in the note.

`memory` is a real answer, not a missing one. Combine freely: `calendar|memory` is common and
informative.

### `abandoned_tool`

`yes` if they named at least one tool, app, service, or method they used for this and stopped using.
Includes free tools and paper systems. Excludes tools they never really started.

### `paid_for_related_tool`

`yes` if in the last 12 months they paid money for something intended to help with organisation,
focus, planning, or time management.

Counts: paid app or subscription (even forgotten ones), coaching, tutoring in study skills, a
course, a paid planner or notebook system, a therapist **engaged specifically for organisational
support** — record only the paid behavior, never anything clinical.

Does not count: free tiers, employer-provided tools, a gift, anything bought for someone else,
general stationery.

Structural: a `commercial`-cohort row must have `yes`. If it does not, the cohort tag is wrong, not
the answer.

### `privacy_boundary`

`yes` if they described at least one concrete boundary they have actually enforced, or one specific
thing they would refuse to share.

*Illustrative `yes`:* "I turned off the calendar permission for that app after it started emailing
me summaries."
*Illustrative `yes`:* "I'd never connect anything to my work email."
*Illustrative `no`:* "I don't really think about it" — with nothing further at 7.5.

### `switching_pain`

From block 6.9, coded on the work described, not the emotion.

| Value | Evidence |
| --- | --- |
| `none` | Never switched, or nothing had to be redone |
| `low` | A few items re-entered by hand, one sitting |
| `medium` | Real re-entry work, completed |
| `high` | Days of work, or the switch was abandoned, or they still run both systems |

### `preferred_baseline`

`current_workflow` | `chatgpt_calendar` | `chatgpt_todoist`. Full decision table in
[06-competitive-baseline-questions.md](06-competitive-baseline-questions.md#coding).

### `competitive_comparison_completed`

`yes` when block 6 ran through 6.10. `no` when it was cut for time or the participant would not
choose — in which case `preferred_baseline` is `current_workflow` as a forced default, and the row
is excluded from the comparison denominator.

### `evidence_ref`

`research://v03/<interview_id>`. A pointer to the note on the research drive. It must never contain a
quote, a name, or a URL to anything reachable from outside the drive. The schema enforces the shape
and rejects duplicates.

### `primary_coder` / `second_coder` / `second_coder_pain_qualified` / `adjudicated`

Coder codes, e.g. `coder-a`. `second_coder` is empty unless the row is in the double-coding sample.
When it is set, `second_coder_pain_qualified` records that coder's **independent** yes/no on
qualified pain, formed without seeing the primary code. `adjudicated=yes` records that a
disagreement was discussed and resolved. The intake tool blocks on unadjudicated disagreements.

---

## Recruitment tracker fields

### `candidate_id`

Pseudonymous, `cand-001` style. Distinct from `interview_id` so that the funnel and the evidence stay
separable — a candidate who never interviews still has a row.

### `source_channel`

| Code | Means |
| --- | --- |
| `adhd_community` | Forum, group, or community focused on ADHD/executive function |
| `productivity_community` | General productivity forum or group |
| `coaching_network` | Through a coach, tutor, or similar practitioner |
| `university_board` | Campus noticeboard, faculty channel, official student list |
| `student_group` | Student society, WhatsApp/Telegram group, informal campus network |
| `referral` | Introduced by another participant |
| `personal_network` | The researcher's own friends, family, or colleagues |
| `other` | Anything else — describe in the note |

`personal_network` is capped at 20% of the sample. `referral` clusters and should be watched: both
recruit people who resemble people who already agreed.

### `screened_at`

UTC ISO timestamp of the screener, not of the interview.

### `screener_outcome`

`qualified` | `not_qualified` | `declined` | `no_response`. Defined in
[01-participant-screener.md](01-participant-screener.md#qualification-criteria). Never delete a row
to tidy the funnel.

### `adult_confirmed` / `cohort_eligibility_confirmed` / `research_consent_recorded`

From the screener and the consent script. A row missing any of them stays in the operational tracker
and is excluded from the coded recruitment artifact.

### `screener_pain_signal`

The **provisional** signal from screener S3 — not evidence. It exists so recruiting yield can be
compared against final coded qualification. A large gap between the two means the screener is
letting the wrong people through.

### `linked_interview_id`

Empty until the interview happens, then the matching `interview_id`. This link is what turns an
interviewed participant into a qualifiable pilot candidate; see
[13-pilot-handoff-rules.md](13-pilot-handoff-rules.md).

### `pilot_contact_consent_recorded`

From the closing question only. Never inferred from interest, from questions about the product, or
from a friendly interview.

### `pilot_status`

`not_invited` → `invited` → `accepted` | `declined`, with `withdrawn` reachable from any state.
`accepted` is not a thing you type — it is a thing the handoff rules permit. The intake tool
withholds any `accepted` row that fails them.

### `withdrawn_at` / `deletion_completed`

`withdrawn_at` is required when `pilot_status=withdrawn` and forbidden otherwise.
`deletion_completed` records that the deletion actually ran, not that it was promised.

---

## Fields that do not exist, deliberately

There is no field for: name, contact details, age, gender, location, employer, university, income,
diagnosis, medication, or any verbatim quote. The intake tool rejects any cell containing an `@`, a
long digit sequence, or a URL, and the coded schema rejects any key matching
`name|email|phone|address|transcript|raw(message|text)|diagnosis`.

**Diagnosis status is deliberately absent.** No gate in #54, #55, #56, #57, or #61 requires it, so
the study does not collect it. Eligibility for the commercial cohort rests on self-identified
executive-function / intent-to-action difficulty plus the behavioral history in `paid_for_related_tool`,
`abandoned_tool`, and the three primary fields. A participant's diagnosis — present, absent, or
unknown — changes no code in this codebook. If a future gate ever does require it, that is a
protocol change with its own consent language, not a field quietly added here.

There is also no field for compensation. The 75 ILS payment is logged with the identity map, because
it is a fact about a person rather than about a coded interview.

If the study genuinely needs a variable that does not exist here, that is a protocol change: decide
it before collection resumes, write it down, and re-code the earlier interviews. Adding a variable
mid-study and back-filling it from memory is fabrication.
