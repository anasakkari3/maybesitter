# 12 — Calculation method and thresholds

Issue #54. Exactly how every number is computed, and exactly what each threshold does.

All worked numbers below are **arithmetic examples with invented inputs**. None is a result. There
are no results: no interview has been conducted.

Computation lives in `lib/research/v03FieldIntake.ts` and `lib/research/v03BehavioralResearch.ts`,
and is covered by `tests/research/`. Never compute these by hand in a spreadsheet for reporting —
hand arithmetic is how a denominator quietly changes.

---

## Populations and denominators

| Population | Definition | Used for |
| --- | --- | --- |
| **Sample** | Interview rows with `sample_inclusion=sample` | every interview rate |
| Rehearsals | `sample_inclusion=rehearsal` | nothing; excluded everywhere |
| Commercial | Sample rows with `cohort=commercial` | cohort rates |
| Fast-research | Sample rows with `cohort=fast_research` | cohort rates |
| **Comparisons** | Sample rows with `competitive_comparison_completed=yes` | competitive rate only |
| Screened | All recruitment rows | funnel only |
| **Accepted** | Recruitment rows at `accepted` that pass every handoff rule | the 25–40 target |

Withdrawn participants are **deleted**, not counted as negatives. A withdrawal reduces the
denominator. Never carry a withdrawn interview as a `no`.

Every rate is reported with its denominator, always. A rate whose denominator is zero is reported as
`null`, never as `0` and never as "n/a" — the tooling enforces this.

---

## 1. Recurring weekly pain %

```
recurringWeeklyPainRate = count(recurring_weekly_pain = yes) / |Sample|
```

This is the **marginal** rate: how many people have the frequency, regardless of cost. It is
diagnostic, not the threshold metric.

*Illustrative:* 32 in the sample, 24 with `recurring_weekly_pain=yes` → 24 / 32 = **0.750 (75.0%,
n=32)**.

## 2. Concrete-cost %

```
concreteCostRate = count(concrete_cost = yes) / |Sample|
```

Also marginal, also diagnostic. Note the denominator is the **whole sample**, not the people with
recurring pain. Dividing by the pain subgroup produces a different, higher number that answers a
different question; do not report it as the concrete-cost rate.

*Illustrative:* 32 in the sample, 22 with `concrete_cost=yes` → 22 / 32 = **0.688 (68.8%, n=32)**.

## 3. Qualified pain % — the threshold metric

```
qualifiedPain      = past_behavior_example AND recurring_weekly_pain AND concrete_cost
qualifiedPainRate  = count(qualifiedPain) / |Sample|
```

This, and only this, is what the #54 thresholds are applied to. It is a conjunction, so it is
always less than or equal to both marginal rates.

*Illustrative, continuing:* of the 32, 21 have all three → 21 / 32 = **0.656 (65.6%, n=32)** — below
the 70% success threshold and above the 40% failure signal, so **inconclusive**, even though the two
marginal rates look healthier. That divergence is the reason all three numbers are reported
together: it says the problem is frequent but often costless, which is a different product problem
than the problem being rare.

## 4. Cohort differences

Computed as a plain difference of rates, commercial minus fast-research, in rate points:

```
difference(metric) = rate(metric | commercial) − rate(metric | fast_research)
```

Reported for: `recurringWeeklyPain`, `concreteCost`, `qualifiedPain`, `paidForRelatedTool`,
`mediumOrHighSwitchingPain`. `null` when either cohort is empty.

*Illustrative:* commercial 16 interviews, 13 qualified → 0.813. Fast-research 16, 8 qualified →
0.500. Difference = **+0.313 (+31.3 points)**, commercial higher.

**These are descriptive, not inferential.** With cohorts of 15–20 there is no meaningful
significance test to run and none should be reported. Do not write "significantly higher". Write the
two rates, their denominators, and the difference, and let the reader see the sample size.

## 5. Competitive baseline rate

```
existingWorkflowPreferenceRate = count(preferred_baseline = current_workflow) / |Comparisons|
```

Denominator is **Comparisons**, not Sample. At #57, `≥ 0.70` is a PIVOT signal and fewer than 10
comparisons blocks the gate entirely.

*Illustrative:* 28 completed comparisons, 19 preferring their current workflow → 19 / 28 =
**0.679 (67.9%, n=28)**.

## 6. Recruitment

```
accepted = |recruitment rows at `accepted` that pass every handoff rule|
```

Target 25–40. Rows typed as `accepted` that fail a handoff rule are **withheld** from the count and
reported separately as `funnel.acceptedWithUnmetHandoff`. See
[13-pilot-handoff-rules.md](13-pilot-handoff-rules.md).

## 7. Inter-coder agreement

```
agreementRate = count(second_coder_pain_qualified == qualifiedPain) / |double-coded rows|
```

Reported with its denominator. Below roughly 80%, the primary metric is not reliable and the #54
comment must say so rather than presenting the rate as clean.

---

## The #54 thresholds

### The decision rule, exactly

```
if |Sample| < 30 or |Sample| > 40   → insufficient_sample     (no decision exists)
else if qualifiedPainRate ≥ 0.70    → success
else if qualifiedPainRate < 0.40    → failure
else                                → inconclusive
```

Implemented once, in `buildV03ResearchReport`, and tested at the boundaries.

| Rate | Decision | What it means |
| --- | --- | --- |
| ≥ 70% | **success** | The problem is recurring and costly for the target group. #54's evidence criterion is met. |
| 40% – < 70% | **inconclusive** | Real but not at the bar. Not a pass. Report as inconclusive and let #57 weigh it. |
| < 40% | **failure signal** | The problem is not there at the assumed frequency. Report it and prepare a PIVOT recommendation for #57. |

### Boundary handling

- **Exactly 0.70 is success.** The comparison is `≥`. 21/30 = 0.700 passes.
- **Exactly 0.40 is not failure.** The comparison is `<`. 12/30 = 0.400 is inconclusive.
- **No rounding.** 20/30 = 0.6667 is inconclusive, not "70%". Report rates to three decimal places
  and percentages to one; never round a value across a threshold in either direction.
- **29 interviews is not a result**, however good the rate looks. 41 is not a result either — the
  window closes at 40 and interview 41 destroys it. The tooling returns `insufficient_sample` for
  both, and raises a blocker for the overrun.

### What a success does not license

A `success` decision means the interview evidence criterion of #54 is satisfied. It does not mean:

- the market is viable — that is gate #61;
- people will pay — that is #59;
- people will keep using it — that is #58;
- MaybeSitter beats the alternatives — nobody in this study has used it.

### Readiness conditions that override a headline pass

All of these are approved project defaults (2026-08-09), not thresholds from #54. They are enforced
as `decisionReadiness.unmetRequirements`, so the tooling will not call the study reportable while
any of them holds:

1. **Commercial cohort under 15 interviews.** #54's non-goal is explicit: global market viability
   must not be inferred from the bilingual student cohort. A 75% overall rate carried by 25 students
   and 5 commercial-cohort adults is not the finding it appears to be.
2. **Fewer than the required double-coded interviews** — `max(6, ceil(0.2 × sample))`. Without it,
   the primary metric rests on one person's unchecked judgement.
3. **Over 20% of interviews from the researcher's personal network.** People who agree to help a
   friend report the friend's problem.
4. **Fewer than 10 completed competitive comparisons**, which the #57 gate blocks on outright.

Recruitment targets — commercial 20–25, bilingual students 10–15 — are surfaced as `nextActions`
rather than requirements, since the binding constraints are the 30–40 window and the commercial
minimum of 15.

**None of these changes a computed rate.** Every numerator and denominator on this page is derived
from the coded rows alone; a sample that violates all four produces exactly the same
`qualifiedPainRate` as one that satisfies them. What they change is whether that rate may be
presented as evidence. Do not "adjust" a rate for cohort imbalance, and do not reweight — report the
rate, the denominators, and the unmet conditions side by side.

---

## Feeding the #57 gate

`V03GateInput.interviews` and `.competitive` come straight from the intake status:

| Gate field | Source |
| --- | --- |
| `interviews.total` | `progress.interviews.sample` |
| `interviews.commercial` | `cohortIntegrity.commercialInterviews` |
| `interviews.fastResearch` | `cohortIntegrity.fastResearchInterviews` |
| `interviews.recurringWeeklyPainWithConcreteCost` | `rates.overall.qualifiedPain` |
| `competitive.completedComparisons` | `competitive.completedComparisons` |
| `competitive.existingWorkflowPreferred` | `competitive.existingWorkflowPreferred` |
| `evidenceChecksums.researchSha256` | `report.evidenceIntegrity.interviewsSemanticSha256` |
| `dependencies.issue54Complete` | **a human judgement**, only true when the sample is 30–40, coding is adjudicated, and both conditions above are cleared |

The gate independently re-checks the 30–40 window, the cohort reconciliation, and the <40% PIVOT
rule, and fails closed. That redundancy is intentional; do not remove either check.

Note the name mismatch: the gate field is called `recurringWeeklyPainWithConcreteCost` but takes the
**three-way** conjunction, including `past_behavior_example`. Feeding it the two-way count would
overstate the rate.

---

## Reporting template for the #54 comment

Fill from the committed report. Post nothing until `evaluation-reports/v03-behavioral-research.json`
exists and is derived from real trackers.

```markdown
## #54 behavioral research result — <SUCCESS | INCONCLUSIVE | FAILURE SIGNAL>

Report: `evaluation-reports/v03-behavioral-research.json`
Evidence fingerprints: interviews `<sha256>` · recruitment `<sha256>`
Fieldwork period: <start> – <end>

### Sample
- Interviews in sample: <n> (target 30–40); rehearsals excluded: <n>
- Commercial cohort: <n> · fast-research cohort: <n>
- Withdrawn and deleted: <n>
- Recruitment channels: <breakdown>; personal network <n> (<x>%)

### Primary metric
- Qualified pain (past example AND recurring weekly AND concrete cost): <n>/<N> = <x.xxx> (<x.x>%)
- Decision at the #54 thresholds (≥70% success, <40% failure): <decision>

### Diagnostic marginals
- Recurring weekly pain: <n>/<N> = <x.x>%
- Concrete cost: <n>/<N> = <x.x>%
- Past-behavior example: <n>/<N> = <x.x>%

### Cohorts (descriptive; no significance claimed)
| Metric | Commercial (n=) | Fast-research (n=) | Difference |
|---|---|---|---|
| Qualified pain | | | |
| Paid for a related tool | | | |
| Medium/high switching pain | | | |

### Competitive baseline
- Completed comparisons: <n>
- current_workflow <n> · chatgpt_calendar <n> · chatgpt_todoist <n>
- Existing-workflow preference: <x.x>% (n=<comparisons>)

### Coding quality
- Second coder: <name>
- Double-coded: <n>/<N> (<x>%), required <max(6, ceil(0.2N))> · agreement <x.x>%
- Disagreements: <n>, all adjudicated: yes/no
- Recodes after adjudication: <n>, and why

### Sampling plan vs actual
- Commercial: <n> (target 20–25, readiness minimum 15)
- Bilingual students: <n> (target 10–15)
- Personal network: <n> (<x>%, cap 20%)
- Compensation: 75 ILS per completed interview, unconditional, <n> paid
- Campus ethics determination: <status and date>
- Deviations from the sampling plan, and why

### Recruitment
- Screened <n> → screener-qualified <n> → interviewed <n> → pain-qualified <n>
  → contact-consented <n> → invited <n> → accepted <n> (target 25–40)

### Limitations
- Fast-research cohort evidence is segmented and is not global market evidence.
- Coded interview evidence establishes neither retention nor willingness to pay.
- <protocol deviations, leading questions logged, blocks cut, cohort overlap count>

### Status
<Whether #54's evidence criterion is met, and what remains before it can close.>
```

If the result is a failure signal, report it in exactly this format and recommend PIVOT at #57. Do
not extend the sample past 40 in search of a better number: that invalidates the window, and the
tooling will say so.
