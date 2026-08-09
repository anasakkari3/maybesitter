# 11 — Recruitment tracker and interview evidence tracker

Issue #54. The two CSVs that carry the study. Everything else in this kit produces or consumes them.

**They live on the access-controlled research drive, never in Git.** Only the derived, privacy-safe
JSON report is committed. Header-only templates are in [templates/](templates/); they are generated
from `lib/research/v03FieldIntake.ts` and a test fails if they drift.

Do not edit the header row. Do not add columns. Do not reorder. The intake tool rejects a drifted
header before reading a single row, which is the point: a spreadsheet that has quietly grown a
"notes" column is a spreadsheet that will eventually contain a name.

---

## Recruitment tracker

`recruitment-tracker.csv` — one row per **candidate**, created at first contact, updated through the
funnel. A candidate who never interviews keeps their row; deleting them inflates every conversion
rate in the study.

| # | Column | Values | Written when |
| ---: | --- | --- | --- |
| 1 | `candidate_id` | `^[a-z0-9][a-z0-9_-]{2,63}$`, e.g. `cand-014` | first contact |
| 2 | `cohort` | `commercial` \| `fast_research` | screener, then never |
| 3 | `source_channel` | `adhd_community` \| `productivity_community` \| `coaching_network` \| `university_board` \| `student_group` \| `referral` \| `personal_network` \| `other` | first contact |
| 4 | `screened_at` | UTC ISO, `2026-09-10T09:00:00Z` | screener |
| 5 | `screener_outcome` | `qualified` \| `not_qualified` \| `declined` \| `no_response` | screener |
| 6 | `adult_confirmed` | `yes` \| `no` | screener S1 |
| 7 | `cohort_eligibility_confirmed` | `yes` \| `no` | screener S7/S8 |
| 8 | `research_consent_recorded` | `yes` \| `no` | consent script C8 |
| 9 | `screener_pain_signal` | `yes` \| `no` | screener S3 — provisional, not evidence |
| 10 | `linked_interview_id` | interview ID, or empty | after the interview |
| 11 | `pilot_contact_consent_recorded` | `yes` \| `no` | closing question only |
| 12 | `pilot_status` | `not_invited` \| `invited` \| `accepted` \| `declined` \| `withdrawn` | as it changes |
| 13 | `withdrawn_at` | UTC ISO, or empty | on withdrawal |
| 14 | `deletion_completed` | `yes` \| `no` \| empty | when deletion actually runs |

Cross-row rules the tool enforces:

- `screener_outcome=qualified` requires `adult_confirmed=yes`.
- `pilot_status=withdrawn` requires `withdrawn_at`; any other status forbids it.
- `candidate_id` must be unique.
- No cell may contain `@`, a long digit run, or a URL.

There is no `qualified` column. Qualification is **derived** from the handoff rules in
[13-pilot-handoff-rules.md](13-pilot-handoff-rules.md), so it cannot be typed optimistically.

## Interview evidence tracker

`interview-evidence-tracker.csv` — one row per **completed interview**, written within 24 hours from
[the note](08-interview-note-template.md).

| # | Column | Values | Source |
| ---: | --- | --- | --- |
| 1 | `interview_id` | `^[a-z0-9][a-z0-9_-]{2,63}$`, e.g. `int-014` | assigned before the call |
| 2 | `sample_inclusion` | `sample` \| `rehearsal` | fixed before the call |
| 3 | `cohort` | `commercial` \| `fast_research` | screener |
| 4 | `interview_language` | `en` \| `ar` \| `he` \| `mixed` | the interview |
| 5 | `cohort_eligibility_confirmed` | `yes` (only) | screener |
| 6 | `occurred_at` | UTC ISO | the interview |
| 7 | `research_consent_recorded` | `yes` (only) | consent C8 |
| 8 | `adult_confirmed` | `yes` (only) | consent C8 |
| 9 | `past_behavior_example` | `yes` \| `no` | block 2 |
| 10 | `recurring_weekly_pain` | `yes` \| `no` | block 3 |
| 11 | `concrete_cost` | `yes` \| `no` | block 2 |
| 12 | `current_workflows` | pipe-separated: `paper` \| `calendar` \| `todo_app` \| `chat_ai` \| `notes` \| `memory` \| `other` | block 4 |
| 13 | `abandoned_tool` | `yes` \| `no` | block 5 |
| 14 | `paid_for_related_tool` | `yes` \| `no` | block 5 |
| 15 | `privacy_boundary` | `yes` \| `no` | block 7 |
| 16 | `switching_pain` | `none` \| `low` \| `medium` \| `high` | block 6.9 |
| 17 | `preferred_baseline` | `current_workflow` \| `chatgpt_calendar` \| `chatgpt_todoist` | block 6.10 |
| 18 | `competitive_comparison_completed` | `yes` \| `no` | block 6 ran to 6.10 |
| 19 | `evidence_ref` | `research://v03/<interview_id>` | note location |
| 20 | `primary_coder` | `^[a-z0-9][a-z0-9_-]{1,31}$`, e.g. `coder-a` | coding |
| 21 | `second_coder` | coder code, or empty | double-coding sample |
| 22 | `second_coder_pain_qualified` | `yes` \| `no` \| empty | independent second code |
| 23 | `adjudicated` | `yes` \| `no` | after disagreement resolution |

Cross-row rules the tool enforces:

- Columns 5, 7, and 8 must be `yes`. There is no way to code an interview without consent.
- A `commercial` row requires `paid_for_related_tool=yes`.
- `second_coder` and `second_coder_pain_qualified` are set together or not at all, and the second
  coder must differ from the primary.
- `interview_id` and `evidence_ref` must both be unique.
- No cell may contain `@`, a long digit run, or a URL.

Example row shape, with **invented** values, to show the format only — never copy it into a tracker:

```csv
int-014,sample,commercial,en,yes,2026-09-14T09:00:00Z,yes,yes,yes,yes,yes,calendar|notes,yes,yes,yes,medium,current_workflow,yes,research://v03/int-014,coder-a,coder-b,yes,no
```

---

## The third file: the identity map

Not a tracker, and not described by any schema here, deliberately. A separate file, in a separate
location, with separate access, containing only:

```
candidate_id → how to contact this person
```

It also carries the **compensation log** — who was paid the 75 ILS and when. Payment is a fact about
a person, so it belongs here and never in a tracker cell.

It is the only place a real identity exists. It is never emailed, never copied to a laptop, never
committed, and never joined to a tracker in a spreadsheet — not even temporarily to "check
something".

**Deletion:** 30 days after recruitment closes, except for entries where the participant gave
explicit future-contact consent, where only what is needed for that contact is kept. Identifiable
interview notes are converted to coded rows and the identifiable version deleted no later than 30
days after the #57 gate decision. The coded, de-identified evidence is retained through the #61
Market Evidence Gate plus 90 days. This is the study's operational policy, not a compliance claim.

## Running the tools

```sh
export RESEARCH_DRIVE=/path/to/access-controlled/folder

# weekly — validate, and see where the study stands
npm run research:v03-intake -- \
  --interviews  "$RESEARCH_DRIVE/interview-evidence-tracker.csv" \
  --recruitment "$RESEARCH_DRIVE/recruitment-tracker.csv" \
  --status      "$RESEARCH_DRIVE/v03-fieldwork-status.json"

# at close of sample — also emit the coded evidence
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

### Reading the status output

| Section | What it tells you |
| --- | --- |
| `blockers` | Integrity failures. The command exits non-zero. Fix before the next interview. |
| `decisionReadiness.unmetRequirements` | What still stands between now and a reportable #54. Normal mid-fieldwork. |
| `nextActions` | Concrete next steps, with counts |
| `progress` | Sample and cohort progress against 30–40 and 25–40 |
| `rates` | Marginal and conjunctive rates, overall and per cohort, with denominators |
| `competitive` | The #57 comparison denominator and baseline counts |
| `cohortIntegrity` | Commercial-cohort sufficiency and personal-network share |
| `coding` | Double-coding coverage and agreement |
| `handoff` | Who is ready to invite, and who is wrongly marked accepted |
| `report` | The frozen `V03ResearchReport`, including the threshold decision |

Validation errors print as `file:line [tracker.column] message` and nothing is written. Fix the CSV
and rerun; do not work around the validator.

### If the tool refuses a row you believe is right

It is usually one of four things: a header edited by a spreadsheet, a date written as `14/09/2026`,
a cell auto-formatted by Excel, or a cohort/paid-tool contradiction. Open the CSV in a plain text
editor to check. If the row is genuinely correct and the tool is wrong, fix the tool and its test —
do not loosen the schema to get past it.

---

## Where the two open gates land

Everything else — compensation, recording, retention, sampling defaults, sensitive-data
minimization — is settled and recorded in [README.md](README.md).

| Gate | Where it bites |
| --- | --- |
| `SECOND_CODER_NAME` unassigned | `second_coder` stays empty, so `coding.doubleCodingBelowMinimum` stays true and `decisionReadiness` stays unmet. Must be assigned before the fifth sampled interview. |
| `CAMPUS_ETHICS_STATUS = unresolved` | No rows may be created with `source_channel=university_board` or `student_group`. Other channels are unaffected. |

Neither can be defaulted by the tooling, and neither blocks the two rehearsal interviews.
