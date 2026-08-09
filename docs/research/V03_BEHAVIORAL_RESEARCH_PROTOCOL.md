# V03 behavioral research protocol

Issue: #54. Owner: Anas Akkari. Status: fieldwork not started.

This document is the policy. The executable field kit — screener, recruitment messages, consent
script, privacy explanation, interview guide, interviewer instructions, note template, codebook,
coding rubric, competitive baseline questions, tracker schemas, calculation method, and pilot
handoff rules — is in [v03/](v03/). Start at [v03/README.md](v03/README.md). Where the two disagree,
this document wins.

## Decision and sample

Interview 30–40 consenting adults. The success threshold is at least 70% with all three coded observations: a concrete past example, recurring weekly pain, and concrete cost. Below 40% is a failure signal. Results between 40% and 70% are inconclusive. No threshold decision is valid before 30 interviews or after silently exceeding 40.

Recruit 25–40 qualified, separately contact-consented closed-pilot participants. Keep commercial and fast-research cohorts segmented. Arabic/Hebrew bilingual student evidence accelerates learning but is never reported as global market evidence.

## Interview guide

Ask for the most recent real event before discussing MaybeSitter:

1. “Tell me about the last important commitment you forgot or struggled to begin.”
2. “What happened next, and what did it cost in time, money, stress, trust, or opportunity?”
3. “How often has something similar happened during the last four weeks?”
4. “Show me how you recorded or recovered that commitment.”
5. “Which tools have you stopped using? What happened the last time you stopped?”
6. “Which productivity tools, services, or coaching have you paid for?”
7. “Compare your current workflow with ChatGPT + Calendar and ChatGPT + Todoist. Where does switching create work?”
8. “What information would you refuse to share?”
9. “Describe the last time a recommendation felt invasive, judgmental, or incorrect.”
10. “May we contact you separately about a closed pilot?”

Do not ask whether the participant likes the idea, would use “an AI that organizes life,” or thinks a proposed feature sounds useful. Do not coach an answer toward ADHD, diagnosis, payment, or pain.

## Coding rule

Two observations count toward the primary rate only when the interviewer has a past-behavior example and records both recurring weekly pain and a concrete consequence. Interest, stated intent, diagnosis, or general frustration does not count. Store coded records using `BehavioralInterviewRecord`; keep recordings, transcripts, contact details, names, and diagnoses outside Git in an access-controlled research system. `evidenceRef` is a pseudonymous external reference, never a quote.

Commercial cohort participants are adults who self-identify with the target difficulty and have relevant paid-tool behavior. `cohortEligibilityConfirmed` and paid-tool behavior are required structurally for a commercial record. Fast-research participants are coded separately even if they also qualify commercially; use the cohort chosen at recruitment and report overlap as a study limitation outside the coded artifact.

## Approved operational decisions (2026-08-09)

Compensation is 75 ILS per completed interview, identical across cohorts and never contingent on
qualification, answers, pilot enrollment, or positive feedback. No audio or video is recorded;
structured written notes only. Diagnosis status is not collected — eligibility rests on observable
executive-function/intent-to-action difficulty and historical behavior. Retention: recruitment and
contact PII deleted 30 days after recruitment closes absent explicit future-contact consent;
identifiable interview notes coded and then deleted no later than 30 days after the #57 decision;
coded de-identified evidence retained through #61 plus 90 days; withdrawal permitted until the
dataset is de-identified and locked for aggregate analysis. This is operational research policy and
asserts nothing about legal compliance.

Sampling defaults: commercial cohort target 20–25, bilingual student cohort target 10–15, commercial
minimum for decision readiness 15, double-coding at least 20% of analysed interviews with an
absolute minimum of 6, and at most 20% of the analysed sample from the researcher's personal
network. These govern decision readiness only and never alter a measured rate.

Two gates remain open and are not closable by tooling: a named human second coder
(`SECOND_CODER_NAME`, required before the fifth sampled interview; AI assistance does not count as
independent double coding), and `CAMPUS_ETHICS_STATUS = unresolved`, which blocks institutional
student recruitment until Anas determines whether approval or notification is required.

## Consent and recruitment

Record research consent before the interview. Record pilot-contact consent separately; declining contact cannot invalidate research participation. A participant may be marked `accepted` only after adult confirmation, observed behavioral-pain qualification, cohort eligibility, and pilot-contact consent. Withdrawal changes the recruitment status and must trigger the applicable deletion process in the research system.

Do not put contact information in the coded JSONL. Maintain the identity-to-pseudonym map separately with least-privilege access. Export only privacy-safe coded rows for reporting.

## Competitive baseline

Code the workflow the participant actually used most recently, abandoned-tool evidence, paid behavior, switching pain, and which approved comparison best represents the current alternative. The report must show baseline counts and cohort differences; it must not claim MaybeSitter superiority from interview opinion.

## Reproducible report

Coded evidence is derived from the two field trackers rather than hand-written. Validate the
trackers and emit the coded rows, then build the report:

```sh
npm run research:v03-intake -- --interviews <interview-evidence-tracker.csv> --recruitment <recruitment-tracker.csv> \
  --status <status.json> --emit-interviews <coded-interviews.jsonl> --emit-recruitment <coded-recruitment.jsonl>

npm run research:v03-report -- --interviews <coded-interviews.jsonl> --recruitment <coded-recruitment.jsonl> --report <report.json>
```

The intake step rejects direct identifiers in any tracker cell, excludes rehearsal interviews,
derives pilot qualification from the handoff rules instead of accepting a typed value, and reports
cohort sufficiency, recruitment-source bias, competitive-comparison coverage, and inter-coder
agreement. The trackers themselves hold participant data and stay outside Git.

The command validates every row, rejects direct identifiers and raw-text fields, enforces consent, segments cohorts, reports explicit commercial-minus-fast-research deltas, applies the sample and decision thresholds, and pins order-independent SHA-256 semantic fingerprints for both inputs. Synthetic fixtures are tests only and must never be submitted as issue evidence.

## Stop conditions

Stop collection and notify the owner for a consent failure, exposed identity mapping, raw transcript committed to Git, or material privacy incident. Do not activate or expand the product pilot through this research protocol; deployment and runtime activation remain governed by the V02 gate conditions.
