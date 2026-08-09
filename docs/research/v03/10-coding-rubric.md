# 10 — Coding rubric

Issue #54. How to turn a note into a row when the answer is not obvious. Definitions live in
[the codebook](09-evidence-codebook.md); this document is the procedure and the hard cases.

All examples are **invented illustrations**, never interview data.

---

## The rule that decides the study

`qualified_pain = past_behavior_example AND recurring_weekly_pain AND concrete_cost`

All three. Not two of three, not "clearly would have been three". The #54 success threshold —
≥70% — is measured on this conjunction, so every relaxation of it inflates the headline number.

Interest, enthusiasm, agreement with the premise, a diagnosis, and general frustration contribute
**nothing** to it.

## Coding procedure

1. Reread the note top to bottom. Do not code from memory of the conversation.
2. Code the three primary fields first, in order, writing the justification before the value. If you
   cannot write a justification that points at a section of the note, the answer is `no`.
3. Code the remaining fields.
4. Only then look at what the row does to the running rate. If knowing the rate changes your mind,
   you have found a coding bias, not a coding error — leave the code and log it.
5. Enter the row within 24 hours of the interview.

### The order matters

Code `past_behavior_example` before `recurring_weekly_pain`, and `recurring_weekly_pain` before
`concrete_cost`. Each depends on the previous one having a specific event to attach to. A cost with
no event behind it is a story about a category of problem, not a measurement.

## Hard cases

### Past-behavior example

| Case | Code | Why |
| --- | --- | --- |
| Specific event, cannot date it at all | `yes` | Identifiable single event is what matters |
| "Every Monday I forget the standup" — a recurring category, no single instance | `no` at first; ask 3.2 in-interview | A routine is not an event; get the last instance |
| Specific event, but it happened two years ago | `yes` for this field | Recency belongs to `recurring_weekly_pain`, not here |
| Vivid, detailed story about someone else | `no` | Not their behavior |
| Event that only slipped because of illness or a genuine emergency | `yes`, and note it | Real event; the note lets the reader discount it |

### Recurring weekly pain

| Case | Code | Why |
| --- | --- | --- |
| "4+" at S3 and one further example | `yes` | Count plus corroboration |
| "4+" at S3, no second example anywhere | `no` | Unsupported count |
| Three examples in four weeks | `no` | Below weekly; write the real frequency in the note |
| "It was weekly until I fixed it in July" | `no` | Not currently recurring |
| Heavy exam period only, quiet otherwise | `no`, and note the seasonality | Common in the student cohort; a genuine finding worth reporting separately |
| Five examples, all the same forgotten recurring bill | `yes` | Repetition of one kind still recurs |

### Concrete cost

| Case | Code | Why |
| --- | --- | --- |
| "€40 late fee" | `yes` | Money |
| "I had to redo two hours of work" | `yes` | Time, quantified |
| "My partner was annoyed" | `no` | Affect in someone else |
| "My partner had to leave work early to collect them" | `yes` | Material consequence to another person |
| "I lost the client" | `yes` | Opportunity |
| "It was humiliating" | `no` | Feeling |
| "It was humiliating, and I stopped going to that group" | `yes` | The behavioral consequence is concrete |
| "Nothing happened, I caught it in time" | `no` | Near-misses are not costs; note them, they are interesting |
| You suggested the cost and they agreed | `no`, and log the leading question | Your data, not theirs |

The last row is the one to watch. "So you had to pay a fee?" — "Yeah, I suppose so" is not evidence.

### Switching pain

Code the work, not the tone. Ask yourself: *how many items did they re-enter, and over what span?*

| Case | Code |
| --- | --- |
| "I just started fresh and let the old one go" | `none` |
| "I copied over the ten things that mattered" | `low` |
| "I spent an evening moving everything" | `medium` |
| "I gave up half way and now I check both" | `high` |
| Never switched anything | `none` |

### Paid for a related tool

| Case | Code |
| --- | --- |
| Subscription they forgot they had | `yes` |
| Free tier only | `no` |
| Employer pays | `no` |
| A €30 paper planner bought to get organised | `yes` |
| A therapist, mentioned generally | `no` — and record nothing clinical |
| A coach engaged specifically for organisation and follow-through | `yes` |
| Bought once in 2023 | `no` — outside the 12-month window |

Where a therapy engagement genuinely was purchased for organisational support, code `yes` and write
"paid practitioner support for organisation" in the note. Never write the clinical detail.

### Cohort conflicts

| Case | Resolution |
| --- | --- |
| `commercial` row where the participant turns out never to have paid | Cohort was assigned wrongly at screening. Do **not** flip `paid_for_related_tool` to `yes`. Retag the participant to `fast_research` only if they meet that definition; otherwise remove them from the sample as screened-in-error and record the removal in the #54 comment. |
| Bilingual student who pays for tools | Stays `fast_research` if recruited via a campus channel |
| You need one more commercial interview to clear the minimum | Recruit one. Never retag one. |

The last row is the rule that protects the whole cohort split. The minimum exists to stop the
student cohort carrying the result; moving a student into the commercial column to satisfy it
defeats the check entirely.

## Double coding

**Who:** `SECOND_CODER_NAME` — **currently unassigned.** A named human being. AI assistance does not
count as independent double coding, and neither does the same person coding twice: the check exists
to detect one person's drift, and both substitutes inherit exactly the drift being looked for.
Rehearsals may run without a second coder; **the fifth sampled interview may not be completed
without one**, because coverage cannot be reconstructed later at scale.

**Coverage:** at least 20% of analysed sample interviews, and never fewer than **6** in total,
spread across the study — not the first six. At 30 interviews that is 6; at 35, 7; at 40, 8. The
intake tool computes the requirement as `max(6, ceil(0.2 × sample))` and reports the shortfall. A
practical scheme: every fifth interview, plus every interview where the primary coder was unsure.

**Independence:** the second coder reads the note and codes `qualified_pain` yes/no **without seeing
the primary code**. If both codes come from the same person, or the second coder is shown the first
answer, the check measures nothing. The intake tool rejects `second_coder == primary_coder`, but it
cannot detect a compromised process — that is on you.

**Recording:** `second_coder`, `second_coder_pain_qualified`, and `adjudicated`. The tool computes
the agreement rate and blocks on unadjudicated disagreements.

**Adjudication.** When the two disagree:

1. Both state which sentence of the note drove their judgement.
2. Apply this rubric to that sentence.
3. If the note cannot settle it, the answer is `no`. Ambiguous evidence is not qualifying evidence.
4. Set `adjudicated=yes` and record the resolution in the note's coding block.
5. If two adjudications in a row turn on the same ambiguity, the rubric has a gap — fix this
   document before the next interview, and recode the affected rows.

**A low agreement rate is a finding, not an embarrassment.** Below roughly 80% agreement, the
primary metric is not reliable and the #54 comment must say so. Do not fix it by having the second
coder defer.

## When to stop coding and ask

Stop and resolve before entering the row if:

- The note has no justification you can point at for a `yes`.
- You are about to code a `yes` mainly because the participant was enthusiastic.
- You are about to code differently than you would have last week.
- The row would change the running rate across a threshold and you notice yourself caring.
- The note contains an identifier or a diagnosis — delete it first.

## Recoding

Recoding an already-entered row is allowed only when:

- The second coder disagrees and adjudication changes the value, or
- A rubric gap is fixed and the fix applies to earlier rows.

In both cases, recode **every** affected row, not just the ones that move in a helpful direction, and
record what changed and why in the #54 comment. Any other recode is falsification, including a
recode that feels like a correction.
