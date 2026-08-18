# Priority Shadow Comparison

Generated: 2026-08-18T22:04:58.051Z
Schema: priority-calibration-v1

Baseline policy: `priority-policy-v1`
Candidate policy: `priority-policy-candidate-demo`
Sampling: rate 1, seed 0
Compared: 40 commitments
Kendall tau: 0.9949

## Disagreements by cause

| Cause | Count | What it means | Where to look |
| --- | --- | --- | --- |
| `missing_context` | 0 | A re-weighted feature was never measured here, so the commitment stood still while others moved | **Data.** Collect the missing input |
| `scorer_disagreement` | 3 | Different weights over identical known features | **Policy.** The tuning did it |
| `mixed` | 0 | Both: a re-weighted known feature moved the score *and* a re-weighted feature is unknown | **Both.** Collect the input before trusting the tuning |

## Rank changes

| Commitment | Baseline rank | Candidate rank | Cause | Unknown features |
| --- | --- | --- | --- | --- |
| `ps-ar-moderate-02-d` | 27 | 28 | `scorer_disagreement` | urgency, dependency, effort |
| `ps-en-light-01-a` | 28 | 26 | `scorer_disagreement` | urgency, dependency, effort |
| `ps-en-overloaded-01-a` | 26 | 27 | `scorer_disagreement` | dependency, effort |

## Reading this

`dependency` and `effort` are unknown for every commitment — `Commitment` carries
no such fields — so they appear in every "unknown features" cell. They never make a
row `missing_context` on their own: no policy weights them, so both policies are
equally blind to them, and a blindness both sides share cannot explain a difference
between the two sides.

This report changes nothing. The shipped policy is unaffected by any run of it.
