# V03 behavioral research protocol

Issue: #54. Owner: Anas Akkari. Status: fieldwork not started.

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

## Consent and recruitment

Record research consent before the interview. Record pilot-contact consent separately; declining contact cannot invalidate research participation. A participant may be marked `accepted` only after adult confirmation, observed behavioral-pain qualification, cohort eligibility, and pilot-contact consent. Withdrawal changes the recruitment status and must trigger the applicable deletion process in the research system.

Do not put contact information in the coded JSONL. Maintain the identity-to-pseudonym map separately with least-privilege access. Export only privacy-safe coded rows for reporting.

## Competitive baseline

Code the workflow the participant actually used most recently, abandoned-tool evidence, paid behavior, switching pain, and which approved comparison best represents the current alternative. The report must show baseline counts and cohort differences; it must not claim MaybeSitter superiority from interview opinion.

## Reproducible report

Run:

```sh
npm run research:v03-report -- --interviews <coded-interviews.jsonl> --recruitment <coded-recruitment.jsonl> --report <report.json>
```

The command validates every row, rejects direct identifiers and raw-text fields, enforces consent, segments cohorts, reports explicit commercial-minus-fast-research deltas, applies the sample and decision thresholds, and pins order-independent SHA-256 semantic fingerprints for both inputs. Synthetic fixtures are tests only and must never be submitted as issue evidence.

## Stop conditions

Stop collection and notify the owner for a consent failure, exposed identity mapping, raw transcript committed to Git, or material privacy incident. Do not activate or expand the product pilot through this research protocol; deployment and runtime activation remain governed by the V02 gate conditions.
