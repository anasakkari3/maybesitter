# V03 pilot activation, trust, and early-utility gate

Issue: #57. Gate owner: **Anas Akkari**. Current decision: **HOLD** because Issues #54, #55, and #56 remain open.

## Allowed decisions

The report records exactly one of `GO`, `CONDITIONAL GO`, `PIVOT`, or `HOLD`. Missing dependencies, an invalid sample, broken assignment, unresolved incidents, or missing evidence fail closed to HOLD. Problem failure or strong preference for existing workflows produces PIVOT rather than an engineering continuation.

## Required evidence

- #54: 30–40 behavior-first interviews, commercial/fast-research cohort split, and competitive workflow coding.
- #55: 25–40 qualified closed-pilot users, activation and repeated behavior, consent/opt-out, exposure audit, incidents, owner, and rollback evidence.
- #56: baseline/contextual/personalized assignment integrity, recommendation behavior, corrections, perceived invasiveness, latency, and cost.
- Privacy-safe evidence references only. Raw input, transcripts, contact details, diagnoses, and user names never enter the gate artifact.

Metrics always retain their denominators. The early behavioral checks use activation 25%, repeated acceptance 35%, and repeated completion 25%. Trust/privacy objections above 30% require HOLD; invasive feedback at or above 25% is a major failure signal. These pilot checks do not replace Week-4/Week-8 or pricing evidence required by V04.

## Execution

Prepare a privacy-safe JSON input conforming to `V03GateInput`, pin the exact candidate SHA, and run:

```sh
npm run gate:v03 -- --input <gate-input.json> --report evaluation-reports/v03-pilot-gate.json
```

The gate validates reconciled counts, cohort totals, denominators, assignment integrity, latency/cost values, operational evidence, and evidence references before producing a decision. Synthetic fixtures are tests only and must never be cited as pilot evidence.

## Exit requirements

The issue comment and committed report must name the decision, candidate SHA, dependency evidence, accepted limitations, required changes before V04, and evidence links. A GO or CONDITIONAL GO permits only the explicitly reviewed narrow pilot scope; it does not unlock Stage B modules.
