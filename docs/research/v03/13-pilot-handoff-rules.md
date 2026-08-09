# 13 — Handoff rules: interviewed participant → qualified pilot candidate

Issue #54 recruits the cohort that issue #55 runs. This document is the boundary between them.

The failure this prevents is specific and easy: a good interview, a friendly participant, an
enthusiastic "sure, I'd try it", and a person in the pilot who was never behaviorally qualified.
That person then appears in the #57 gate as one of the 25–40 "qualified users", and the gate's
activation and acceptance rates are computed over a cohort that does not match its own definition.

So qualification is **derived, not declared**. There is no `qualified` column to type into. The rule
set below is implemented in `handoffBlockers()` in `lib/research/v03FieldIntake.ts`, and the intake
tool withholds any row that violates it from the coded evidence.

---

## The pipeline

```
  contacted
     │  screener (01)
     ▼
  screened ──────────► not_qualified / declined / no_response   (row stays in the tracker)
     │
     │  consent (03) + interview (05)
     ▼
  interviewed
     │  coded within 24h (09, 10)
     ▼
  pain-qualified ─────► not pain-qualified  (interview still counts as evidence; no pilot invite)
     │
     │  ALL SEVEN GATES BELOW
     ▼
  qualified pilot candidate
     │  invitation R7 (02)
     ▼
  invited ────────────► declined
     │
     ▼
  accepted  ──────────► withdrawn (any time, from any state)
```

## The seven gates

A candidate may be invited to the pilot only when **every one** of these holds. Each maps to a
string returned by `handoffBlockers()`.

| # | Gate | Blocker text |
| ---: | --- | --- |
| 1 | Adult confirmed at the screener | `adult confirmation missing` |
| 2 | Cohort eligibility confirmed | `cohort eligibility not confirmed` |
| 3 | Research consent recorded | `research consent not recorded` |
| 4 | Screener outcome is `qualified` | `screener outcome is <outcome>` |
| 5 | A linked interview exists, is in the sample, and matches the cohort | `no linked interview` / `linked interview <id> is missing or failed validation` / `linked interview is a rehearsal and carries no evidence` / `linked interview cohort does not match the candidate cohort` |
| 6 | The linked interview is behaviorally pain-qualified — all three coded fields `yes` | `linked interview is not behaviorally pain-qualified` |
| 7 | Separate pilot-contact consent recorded at the end of the interview | `separate pilot-contact consent not recorded` |
| — | And they have not withdrawn | `participant withdrew` |

### Why each one is there

1–3 are the lawful basis. Without them there is no participant, only a person you talked to.

4 keeps the screener meaningful. A candidate who failed screening and was interviewed anyway — it
happens, usually as a favour — is evidence but not a pilot candidate.

5 is the anti-shortcut. Without a linked, sampled, cohort-matched interview, "qualified" would rest
on the screener's provisional signal, which is deliberately generous. Rehearsals are excluded
because their purpose was to fix your questions, not to assess a person.

6 is the substantive gate: the pilot cohort must have the problem the pilot is testing a solution
for. This is the gate that enthusiasm most wants to route around.

7 is consent hygiene. Willingness to be interviewed is not permission to be contacted later, and it
is recorded in a different cell for exactly that reason.

## Sequencing rules

- **Never invite before coding.** The interview must be coded and the row entered before R7 goes
  out. Inviting on the strength of how the conversation felt is how gate 6 gets bypassed, and the
  intake tool will catch it a week later when it is awkward to reverse.
- **Never invite during the interview.** The pilot question at the end asks for permission to make
  contact later; it is not an invitation, and must not be delivered as one.
- **Never batch.** Invite as candidates qualify. A single mail-out at the end tempts you to include
  the borderline rows to reach 25.
- **Never negotiate a gate.** If a candidate you want fails gate 6, they are not in the pilot. The
  correct response is to recruit another candidate.

## Cohort composition of the pilot

The 25–40 accepted participants should carry both cohorts, in a proportion that lets #55 and #56
segment their results. Record the split; if either cohort falls below 8 accepted participants, say
so in the #55 and #57 records as a stated limitation on any cohort-level pilot finding. That figure
is a reporting convention set here, not a threshold from any issue, and the owner may set it
differently in writing.

The commercial-cohort minimum that governs #54's interview evidence does **not** transfer
automatically to the pilot cohort; they are different populations answering different questions.
Decide the pilot's target split explicitly rather than inheriting it by accident.

## Status transitions

| From | To | Trigger | Also record |
| --- | --- | --- | --- |
| `not_invited` | `invited` | R7 sent, all seven gates pass | — |
| `invited` | `accepted` | They say yes | pseudonymous pilot ID assigned per the runbook |
| `invited` | `declined` | They say no, or do not reply within 7 days | reply with R8 if they answered |
| any | `withdrawn` | They withdraw, by any means | `withdrawn_at`, then `deletion_completed` when the deletion runs |

`accepted` is where the boundary is enforced hardest: the frozen recruitment schema rejects an
accepted record that is not behaviorally qualified, cohort-eligible, and contact-consented, and the
intake tool withholds such a row rather than crashing — reporting it under `blockers` and counting
it in `funnel.acceptedWithUnmetHandoff` so it cannot silently pad the cohort.

## What happens on the #55 side

Accepting a candidate does **not** activate anything. Handing off to #55 means:

1. The candidate has a pseudonymous pilot ID, generated randomly — not the `candidate_id`, and not a
   sequential number.
2. That ID goes into the closed-pilot allowlist described in
   [../../operations/V03_CLOSED_PILOT_RUNBOOK.md](../../operations/V03_CLOSED_PILOT_RUNBOOK.md),
   which itself requires 25–40 entries and rejects duplicates and identifiers.
3. Each participant gets an isolated runtime and data directory. The current storage is single-user;
   a shared runtime is prohibited.
4. Pilot exposure still requires the V02 activation conditions
   (`MAYBESITTER_FEATURE_RECOMMENDATION=true`, `MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false`) and
   Anas Akkari's explicit approval, recorded at #53. **Nothing in #54 authorises activation.**

The research consent covers the interview. The pilot has its own consent, its own progressive
disclosure ladder, and its own controls. Do not treat one as covering the other.

## Withdrawal, at any point before the data is locked

Withdrawal is available until the relevant dataset has been de-identified and locked for aggregate
analysis. After that there is no link between a person and a row, so there is nothing left to
remove; tell participants that plainly rather than implying otherwise.

1. Reply with R8. No reason requested, no retention attempt.
2. Set `pilot_status=withdrawn`, `withdrawn_at` (required by the tool), and `deletion_completed=yes`
   once deletion has actually run.
3. Delete the interview note, the tracker row, and the identity-map entry. The interview leaves the
   denominator — it is not a negative.
4. If they were already in the pilot, follow the runbook's revocation and deletion paths, and
   remove the pilot ID from the allowlist.
5. Count withdrawals in the #54 comment.

## Audit

At the close of recruitment, for each accepted participant, you should be able to show, without
naming them: the screener row, the linked interview row, the coded pain qualification, the recorded
pilot-contact consent, and the invitation date. If you cannot show all five for someone, they do not
belong in the cohort, and removing them before the gate is far better than discovering it at #57.
