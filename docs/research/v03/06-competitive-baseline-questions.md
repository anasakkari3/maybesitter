# 06 — Competitive workflow baseline questions

Issue #54, block 6 of [the interview guide](05-interview-guide.md). 5 minutes. Feeds the
`competitive` evidence the #57 gate requires.

The question this block answers is **"what would this product actually be replacing?"** — not
"is our product better". Nobody in this study has used MaybeSitter, so no comparison to it is
possible or permitted. What is comparable is what the participant already does versus what they
already tried.

The three approved baselines are fixed by `lib/research/v03BehavioralResearch.ts`:

| Code | Means |
| --- | --- |
| `current_workflow` | whatever the participant does today — including nothing but memory |
| `chatgpt_calendar` | a general chat assistant plus a calendar |
| `chatgpt_todoist` | a general chat assistant plus a task manager |

`current_workflow` is the default and the honest one for most people. Do not treat it as a
non-answer, and do not steer toward the ChatGPT options because they make a more interesting
finding. At #57, `existingWorkflowPreferenceRate ≥ 70%` is a **PIVOT** signal — that is the point of
measuring it, so measuring it accurately matters more than the result being convenient.

---

## Questions

> **6.1** Have you ever used ChatGPT, Claude, Gemini, or similar for anything to do with planning
> your day or keeping track of things you have to do?

Branch on the answer.

### If yes

> **6.2** Tell me about the last time you did that. What did you type in?
>
> **6.3** What did you do with what it gave you?
>
> **6.4** Did anything end up in your calendar or your task list as a result? Who moved it there?
>
> **6.5** Are you still doing that? [If no:] What made you stop?

6.4 is the load-bearing question. The gap between "it produced a plan" and "the plan got into the
system I actually check" is precisely the wedge this product claims. Record whether the participant
did that transfer by hand, and how they described it.

### If no

> **6.6** What made you not try it? Did you consider it?
>
> **6.7** Is there something else you tried instead, in the last year?

"Never occurred to me" is a meaningful answer and should be recorded as such — it tells you the
alternative is not top-of-mind rather than rejected.

### Everyone

> **6.8** If your current way of doing this disappeared tomorrow — the app, the notebook, whatever
> it is — what would you switch to?
>
> **6.9** Last time you moved between tools, how much work was it? What did you have to redo by
> hand?
>
> **6.10** Right now, which of these is doing the most for you: what you already use, a chat
> assistant plus your calendar, or a chat assistant plus a task app?

6.8 is hypothetical in form but past-anchored in substance — it asks about switching, which they
have done before. It is the one permitted forward-looking question in the study, and it is
permitted only because 6.9 checks it against a real prior switch. If the participant's answer to 6.8
contradicts what they actually did in 6.9, trust 6.9 and note the contradiction.

6.10 is the direct question behind `preferred_baseline`. Ask it plainly, accept the answer, do not
argue with it.

---

## Coding

### `preferred_baseline` — exactly one value

| Choose | When |
| --- | --- |
| `current_workflow` | They named their existing setup at 6.10, **or** they have never meaningfully used a chat assistant for this, **or** they tried one and stopped |
| `chatgpt_calendar` | They currently use a chat assistant for planning and the output lands in a calendar |
| `chatgpt_todoist` | They currently use a chat assistant for planning and the output lands in a task manager |

Rules that resolve the ambiguous cases:

- **Currently** means in the last four weeks. A single experiment in March is `current_workflow`.
- Tried and abandoned a chat assistant → `current_workflow`, and `abandoned_tool=yes`.
- Uses a chat assistant but never transfers anything anywhere → `current_workflow`. Producing text
  they don't act on is not a workflow.
- Uses both a calendar and a task app with a chat assistant → pick the destination they named first
  at 6.4, and note the split in the interview note.
- Cannot or will not choose at 6.10 → `current_workflow`, and note it as a forced default.

### `switching_pain` — from 6.9

| Value | Evidence |
| --- | --- |
| `none` | Never switched, or switched with nothing to redo |
| `low` | Switched; a few items re-entered by hand; done in one sitting |
| `high` | Switched and it took days, or they abandoned the switch part-way, or they still run both |
| `medium` | Real re-entry work, but completed — everything between `low` and `high` |

Code from the described work, not from how annoyed they sounded. A calm person who re-entered 200
items over a week is `high`.

### What must not be coded here

- Any comparison to MaybeSitter. It does not exist for these participants.
- Any statement about what they'd prefer if a better tool existed.
- Feature requests. Note them in the interview note if you like; they are not evidence and they do
  not enter the tracker.

---

## Reporting

Every coded row carries a `preferred_baseline`, because the frozen evidence schema requires one. So
a second column, `competitive_comparison_completed`, records whether block 6 actually ran to 6.10.
Without it, an interview cut short for time and defaulted to `current_workflow` would be
indistinguishable from a real comparison, and it would silently inflate the one rate that can
trigger a PIVOT.

- Block 6 ran to 6.10 → `competitive_comparison_completed=yes`.
- Block 6 was cut, or the participant would not answer 6.10 → `no`, and code the baseline as
  `current_workflow` with a note that it is a forced default.

`npm run research:v03-intake` reports `competitive.completedComparisons`,
`competitive.existingWorkflowPreferred`, `competitive.existingWorkflowPreferenceRate`, and the
per-baseline counts. Those go straight into the `competitive` block of the #57 gate input. The
comparison denominator is smaller than the interview sample — never reuse the sample size in its
place. Below 10 completed comparisons the #57 gate blocks, so the intake tool raises it as an unmet
requirement well before you get there.
