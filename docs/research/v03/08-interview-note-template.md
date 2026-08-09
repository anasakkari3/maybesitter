# 08 — Structured interview note template

Issue #54. One note per interview, stored on the research drive, never in Git.

Copy everything between the rules into a new file named `<interview_id>.md` — for example
`int-014.md`. Write the ID at the top **before** the call starts.

The note is the audit trail behind one tracker row. A second coder must be able to read it and reach
the same codes without having been there. That is the standard: not "did I remember it", but "can
someone else reproduce my judgement from this".

**Never write in a note:** the participant's name, contact details, employer, city, university name,
job title in identifying detail, names of other people, or any diagnosis, medication, or treatment.
Write "a family member", "their manager", "a course deadline". If you notice an identifier after
writing, delete it immediately — do not strike it through.

---

```markdown
# Interview <interview_id>

- Date (UTC):
- Duration:
- Language:                    en | ar | he | mixed
- Cohort (fixed at screening): commercial | fast_research
- Linked candidate ID:
- Sample inclusion:            sample | rehearsal
- Consent confirmed aloud:     adult yes/no · research yes/no
- Blocks cut for time:
- Interviewer:

## 1. Ordinary week

Where commitments arrive from:

Notes:

## 2. The last slip

- What it was (no names):
- Roughly when:
- Where it was recorded, if anywhere:
- What they did when they realised:
- What happened as a result:
- Who else was affected:
- Resolved / still open:

Consequence, stated as a fact:
> (one sentence — the thing a second coder will judge `concrete_cost` on)

Did I have to probe for the cost, and how hard?   once | twice | not at all | I pushed too hard

## 3. Frequency

- Count in the last four weeks (their number):
- Second concrete example:
- Third, if given:
- Their own description of the pattern:
- Is "weekly or more" supported by examples rather than by a feeling?   yes | no

## 4. Current workflow

- Observed or described?   observed (screen share) | described only
- Where things actually live:
- What they do when something new arrives:
- Number of separate places:
- What they do when stuck on what's first:
- Workflow codes: paper | calendar | todo_app | chat_ai | notes | memory | other

Gap between claimed and observed:

## 5. Abandoned tools and payment

- Tools tried and dropped:
- Most recent drop — how long used:
- The last straw (in substance, not verbatim):
- Deliberate stop or faded?
- Paid for (what, roughly how much, how long):
- Cancelled — why:
- Re-entry work when switching:
- What stopped them trying something new:

## 6. Competitive baseline

- Ever used a chat assistant for planning?   yes | no
- Last time, what they typed and what they did with the output:
- Did anything reach a calendar or task list? Who moved it?
- Still doing it? If not, why stopped:
- If never: why not:
- What they'd switch to if today's setup vanished:
- Answer to 6.10 (which is doing the most for them):
- Block 6 completed to 6.10?   yes | no
- Baseline: current_workflow | chatgpt_calendar | chatgpt_todoist
- Forced default?   yes | no

## 7. Privacy boundaries

- Last access they refused, and what it was asking for:
- What they did instead:
- Apps with calendar access, and whether they know why:
- A recommendation that felt wrong, intrusive, or judgmental — category and what they did:
- Anything they'd never put into an app:

## 8. Close

- Pilot-contact consent asked separately at the end?   yes | no
- Answer:   yes | no
- Anything they said I should have asked:
- Did I describe the product? At what point?

## Interview quality

- Leading questions I asked (write them out):
- Terms I introduced first:
- Interruptions, technical failures, distress pause:
- Anything that would make a second coder read this differently:

## Coding — fill last, after re-reading the note

| Field | Value | One-line justification pointing at a section above |
| --- | --- | --- |
| past_behavior_example | yes/no | |
| recurring_weekly_pain | yes/no | |
| concrete_cost | yes/no | |
| current_workflows | | |
| abandoned_tool | yes/no | |
| paid_for_related_tool | yes/no | |
| privacy_boundary | yes/no | |
| switching_pain | none/low/medium/high | |
| preferred_baseline | | |
| competitive_comparison_completed | yes/no | |

Qualified pain (all three of the first three = yes):   yes | no

Coder:                     Date coded:
Second coder:              Their pain judgement:   yes | no
Disagreement resolved how:
```

---

## Using it well

- **Fill the coding table last**, after rereading the note top to bottom. Coding as you go turns the
  interview into a form-filling exercise and you stop listening.
- **The justification column is not optional.** "yes — §2, missed a rent payment, €40 late fee" is
  reproducible. A bare "yes" is not, and it is the first thing that breaks at adjudication.
- **Write the leading questions down.** It feels bad and it is the single most valuable line in the
  note.
- **A negative interview deserves a full note.** The temptation is to write three lines and move on.
  Nine of thirty negatives are what separate a real 70% from a wished-for one.
- **File the note before coding the tracker row**, so the note is written from the interview and the
  row is written from the note — not both from memory at once.
- **There is no recording to fall back on.** The note is the only record of the interview, so a thin
  note is a lost interview. Pause the conversation to catch up rather than promising yourself you
  will remember.
- **Payment is not noted here.** Log the 75 ILS with the identity map. It is a fact about a person,
  not about a coded interview, and it must not become a tracker cell.
