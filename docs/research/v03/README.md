# V03 behavioral research and recruitment kit — issue #54

Issue: [#54](https://github.com/anasakkari3/maybesitter/issues/54).
Research owner: **Anas Akkari**.
Status: **fieldwork not started. No interview has been conducted and no participant has been recruited.**

This directory is the field kit: everything needed to run the #54 study without inventing
anything on the day. The policy summary lives in
[../V03_BEHAVIORAL_RESEARCH_PROTOCOL.md](../V03_BEHAVIORAL_RESEARCH_PROTOCOL.md); where the two
disagree, the protocol wins and this kit is the bug.

Nothing here is product code. Nothing here activates the pilot. Pilot exposure remains governed by
the V02 gate conditions and [../../operations/V03_CLOSED_PILOT_RUNBOOK.md](../../operations/V03_CLOSED_PILOT_RUNBOOK.md).

## Approved fieldwork decisions

Signed off by the research owner on 2026-08-09. These are settled; do not renegotiate them
mid-fieldwork. Anything below marked as a *gate* is still open and is listed again at the end.

| Decision | Setting |
| --- | --- |
| **Compensation** | **75 ILS per completed ~45-minute interview**, identical for both cohorts |
| **Recording** | **None.** No audio, no video. Structured written notes only |
| **Retention** | Four rules, below |
| **Commercial cohort target** | 20–25 interviews |
| **Bilingual/student cohort target** | 10–15 interviews |
| **Commercial minimum for decision readiness** | 15 |
| **Double coding** | ≥20% of analysed interviews, absolute minimum 6 |
| **Personal-network cap** | ≤20% of the final analysed sample |
| **Sensitive data** | No diagnosis status collected. Recruit on observable executive-function / intent-to-action pain and historical behavior |

### Compensation is unconditional

75 ILS is paid for completing the interview. It must never depend on qualification, on the answers
given, on pilot enrollment, or on saying anything positive. A participant who turns out not to
qualify, who reports no problem at all, or who declines pilot contact is paid the same. Pay promptly
and record the payment alongside contact details in the identity map, never in a tracker.

### Retention policy

This is the study's operational policy. It is not a statement about legal compliance and must never
be described as one to a participant.

| Data | Deleted |
| --- | --- |
| Recruitment and contact PII | 30 days after recruitment closes, unless the participant gave explicit future-contact consent |
| Identifiable interview notes | Converted to coded evidence, then the raw identifiable notes deleted no later than 30 days after the #57 gate decision |
| Coded, de-identified research evidence | Retained through the #61 Market Evidence Gate, plus 90 days |

**Withdrawal** is permitted at any time up until the relevant dataset has been de-identified and
locked for aggregate analysis. After that point the data can no longer be traced back to an
individual to remove it, and the participant is told so in advance.

### Sampling defaults affect readiness only

The cohort targets, the commercial minimum, the double-coding floor, and the personal-network cap
govern whether a result may be **reported**. None of them touches a measured rate: recurring-pain,
concrete-cost, qualified-pain, cohort-difference, and competitive numbers are computed from the
coded rows alone and are identical whether or not these defaults are met. They live in
`V03_FIELDWORK_DEFAULTS` in `lib/research/v03FieldIntake.ts` and surface as
`decisionReadiness.unmetRequirements` and `nextActions`, never as an adjustment to a numerator or
denominator.

## What #54 has to prove

| Question | Threshold | Where it is computed |
| --- | --- | --- |
| Do 30–40 interviewed adults show recurring weekly pain with a concrete cost? | **success ≥ 70%**, **failure signal < 40%**, 40–70% inconclusive | [12-calculation-and-thresholds.md](12-calculation-and-thresholds.md) |
| Are 25–40 qualified adults recruited into the closed pilot? | 25–40 accepted | [13-pilot-handoff-rules.md](13-pilot-handoff-rules.md) |
| Do the two cohorts differ? | reported, not thresholded | [12-calculation-and-thresholds.md](12-calculation-and-thresholds.md) |
| What is the real competitive alternative? | reported, not thresholded | [06-competitive-baseline-questions.md](06-competitive-baseline-questions.md) |

A pass on the bilingual student cohort alone is **not** market evidence. The tooling refuses to call
the result reportable until the commercial cohort carries at least 15 of the interviews.

## The kit

| # | Document | Used when |
| --- | --- | --- |
| 01 | [Participant screener](01-participant-screener.md) | first contact with a candidate |
| 02 | [Recruitment messages](02-recruitment-messages.md) | posting, DMing, inviting, declining |
| 03 | [Consent script](03-consent-script.md) | first 3 minutes of every interview |
| 04 | [Privacy explanation](04-privacy-explanation.md) | sent before the interview, repeated on request |
| 05 | [Behavioral interview guide](05-interview-guide.md) | the 45-minute interview |
| 06 | [Competitive baseline questions](06-competitive-baseline-questions.md) | block 6 of the interview |
| 07 | [Interviewer instructions](07-interviewer-instructions.md) | read before your first interview, reread weekly |
| 08 | [Structured interview note template](08-interview-note-template.md) | during and immediately after each interview |
| 09 | [Evidence codebook](09-evidence-codebook.md) | when coding a note into tracker cells |
| 10 | [Coding rubric](10-coding-rubric.md) | when a coding call is not obvious |
| 11 | [Trackers](11-trackers.md) | daily; the two CSVs are the study's spine |
| 12 | [Calculation method and thresholds](12-calculation-and-thresholds.md) | when reading or reporting numbers |
| 13 | [Pilot handoff rules](13-pilot-handoff-rules.md) | turning an interviewee into a pilot participant |

Header-only CSV templates: [templates/](templates/). They are generated from
`lib/research/v03FieldIntake.ts` and a test fails if they drift.

## Ready-to-use workflow

The two trackers hold real participant data and therefore **live outside this repository**, in the
access-controlled research drive. Only the derived, privacy-safe coded artifacts are ever committed.

```
                 recruitment tracker (CSV, outside Git)
 screener ─────► one row per candidate ──┐
                                          ├──► npm run research:v03-intake
 interview ────► interview evidence       │      ├─ validates every cell
                 tracker (CSV, outside ───┘      ├─ derives qualification + handoff
                 Git)                            ├─ writes fieldwork status JSON
                                                 └─ emits coded JSONL
                                                        │
                                                        ▼
                                          npm run research:v03-report
                                                        │
                                                        ▼
                                    evaluation-reports/v03-behavioral-research.json
                                                        │
                                                        ▼
                                          #54 comment  →  #57 gate input
```

### Once, before the first participant

1. Create the research drive folder with least-privilege access. It holds three things: the two
   trackers, the interview notes, and the identity↔pseudonym map. The map also holds contact details
   and the compensation log, is stored separately from everything else, and is never copied,
   emailed, or committed.
2. Copy both files out of [templates/](templates/) into that folder. Do not edit the header row.
3. Read [07-interviewer-instructions.md](07-interviewer-instructions.md) end to end.
4. Run two **rehearsal** interviews with people who will never be in the sample. Code them with
   `sample_inclusion=rehearsal`; they are excluded from every denominator and from the coded
   artifact. Fix the guide's wording before interview #1.

**Rehearsals are cleared to proceed.** The participant-facing documents
([03](03-consent-script.md), [04](04-privacy-explanation.md)) carry no unresolved participant-facing
research-policy placeholders. Before sending or posting, fill `[STUDY_CONTACT_EMAIL]` from the
private contact sheet and keep the address out of Git. Sampled interviews additionally require Gate
1 below; institutional student recruitment additionally requires Gate 2.

### Per candidate

1. Log the candidate in the recruitment tracker at first contact — one row, pseudonymous ID only.
2. Run [the screener](01-participant-screener.md). Record the outcome and the cohort tag.
3. If qualified, send [the privacy explanation](04-privacy-explanation.md) and book 45 minutes.
4. Run [the consent script](03-consent-script.md), then [the interview](05-interview-guide.md),
   taking notes on [the template](08-interview-note-template.md).
5. **Within 24 hours**, code the note into one interview-tracker row using
   [the codebook](09-evidence-codebook.md) and [the rubric](10-coding-rubric.md), and link the
   candidate row to it.
6. Apply [the handoff rules](13-pilot-handoff-rules.md) to decide whether to invite them.

### Weekly

```sh
npm run research:v03-intake -- \
  --interviews  "$RESEARCH_DRIVE/interview-evidence-tracker.csv" \
  --recruitment "$RESEARCH_DRIVE/recruitment-tracker.csv" \
  --status      "$RESEARCH_DRIVE/v03-fieldwork-status.json"
```

Read `blockers` first — those are integrity failures and the command exits non-zero. Then
`decisionReadiness.unmetRequirements`, then `nextActions`. Fix blockers before running another
interview.

### When the sample closes

```sh
npm run research:v03-intake -- \
  --interviews  "$RESEARCH_DRIVE/interview-evidence-tracker.csv" \
  --recruitment "$RESEARCH_DRIVE/recruitment-tracker.csv" \
  --status      "$RESEARCH_DRIVE/v03-fieldwork-status.json" \
  --emit-interviews  "$RESEARCH_DRIVE/coded-interviews.jsonl" \
  --emit-recruitment "$RESEARCH_DRIVE/coded-recruitment.jsonl"

npm run research:v03-report -- \
  --interviews  "$RESEARCH_DRIVE/coded-interviews.jsonl" \
  --recruitment "$RESEARCH_DRIVE/coded-recruitment.jsonl" \
  --report      evaluation-reports/v03-behavioral-research.json
```

Only `evaluation-reports/v03-behavioral-research.json` is committed. Then post the #54 comment using
the template in [12-calculation-and-thresholds.md](12-calculation-and-thresholds.md).

## Rules that override convenience

- **Do not fabricate evidence.** No synthetic, illustrative, or "representative" row may enter the
  trackers or the coded artifact. Every fixture in `tests/research/*` is synthetic and is test-only.
  A fabricated row becomes a fabricated consent claim in the #57 gate record.
- **Closing #54 for technical fieldwork-kit preparation does not create evidence.** Real interviews
  and real recruitment are still required before #57 can treat the #54 evidence criterion as met.
- **A negative result closes the issue honestly.** Below 40% is a real, publishable answer and
  should produce a PIVOT recommendation at #57, not another round of recruiting until the number
  improves.
- **Never ask whether someone likes the idea.** The banned-question list in
  [05-interview-guide.md](05-interview-guide.md) is not stylistic.
- **No medical, diagnostic, or therapeutic framing** in any message, script, or note. Self-described
  difficulty is what is collected; a diagnosis is not, and must never be written down.
- **Adults only**, in every cohort, including students.
- **Stop the sample at 40.** Interview 41 destroys the decision window.
- **Pay everyone the same, regardless of what they said.** Compensation is never a reward for the
  answer you wanted.
- **No recording.** If you find yourself wanting a recording, slow the interview down instead.

## Two gates still owned by a human

Everything else is settled. These two are not, and neither may be closed by the kit, by tooling, or
by an AI.

### Gate 1 — `SECOND_CODER_NAME` (unassigned)

A named human second coder must be assigned. **AI assistance does not count as independent double
coding**, and neither does the same person coding twice: the check exists to detect one person's
drift, so a second pass by that same judgement measures nothing.

- Does **not** block the two rehearsal interviews.
- **Must be assigned before the fifth sampled interview is completed.** Coding cannot be caught up
  retroactively at scale without the drift the check is designed to find.
- Until assigned, leave `second_coder` empty. The tooling will report the double-coding shortfall as
  an unmet requirement, which is the correct state.

Replace `SECOND_CODER_NAME` in [10-coding-rubric.md](10-coding-rubric.md) and
[07-interviewer-instructions.md](07-interviewer-instructions.md) when the person is assigned.

### Gate 2 — `CAMPUS_ETHICS_STATUS = unresolved`

Anas must determine whether the college or university requires ethics approval or notification
before students are recruited through institutional channels.

- **Blocks** recruitment via `source_channel=university_board` and `student_group`, and blocks any
  posting on campus noticeboards, faculty lists, or official student channels.
- Does **not** block the commercial cohort, rehearsals, or bilingual students who reach the study
  through a non-institutional route — though those still count toward the personal-network and
  referral caps.
- This kit states no legal conclusion, in either direction. `unresolved` means undetermined, not
  "probably fine".

Record the determination and its date in this file when it is made, and change the status line in
[01-participant-screener.md](01-participant-screener.md) and
[02-recruitment-messages.md](02-recruitment-messages.md).
