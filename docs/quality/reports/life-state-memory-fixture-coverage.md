# Life-State & Memory Fixture Coverage

> **SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE**

Generated: 2026-08-18T13:47:04.440Z
Fixtures: 16 | Valid: 16 | Invalid: 0 | Gaps: 0
Memory records: 32 | Sensitive: 8 | Bidirectional strings: 39
Status: **GATE PASSED**
Seeded-failure test: PASS (20/20 malformed fixtures rejected)

## Coverage matrix

Each cell shows `fixtures · memory records · sensitive records`.

| language | missing | stale | conflicting | sensitive |
|---|---|---|---|---|
| `ar` | 1 · 1 · 0 | 1 · 1 · 0 | 1 · 4 · 0 | 1 · 2 · 2 |
| `he` | 1 · 1 · 0 | 1 · 1 · 0 | 1 · 4 · 0 | 1 · 2 · 2 |
| `en` | 1 · 1 · 0 | 1 · 1 · 0 | 1 · 4 · 0 | 1 · 2 · 2 |
| `mixed` | 1 · 1 · 0 | 1 · 1 · 0 | 1 · 4 · 0 | 1 · 2 · 2 |

## Seeded malformed fixtures

- `malformed-not-an-object` (FIXTURE_NOT_OBJECT): detected — The fixture is a string rather than an object.
- `malformed-invalid-language` (INVALID_LANGUAGE): detected — language is "fr", which the memory contract does not declare.
- `malformed-invalid-condition` (INVALID_CONDITION): detected — condition is "unclear", which is outside the four context conditions.
- `malformed-non-iso-now` (INVALID_TIMESTAMP): detected — now is "18 August 2026", which is not an ISO timestamp.
- `malformed-computed-at-drift` (PROVENANCE_COMPUTED_AT_MISMATCH): detected — A provenance.computedAt is a different instant from the fixture clock.
- `malformed-empty-state-expects-known` (EMPTY_STATE_EXPECTS_UNKNOWN): detected — A missing-condition fixture expects a known commitments field over an empty DomainState.
- `malformed-no-data-over-populated-state` (NO_DATA_OVER_POPULATED_STATE): detected — A populated fixture claims NO_DATA for recentOutcomes instead of a known-zero window.
- `malformed-unknown-reason-outside-vocabulary` (INVALID_UNKNOWN_REASON): detected — An unknown field uses reason "MAYBE", which the contract does not declare.
- `malformed-sensitive-shareable` (SENSITIVE_EXPORT_POLICY): detected — A record marked sensitive expects exportPolicy shareable_aggregate.
- `malformed-confidence-out-of-range` (CONFIDENCE_OUT_OF_RANGE): detected — A record declares confidence 1.4, outside the contract range 0..1.
- `malformed-empty-content` (EMPTY_CONTENT): detected — A record declares whitespace-only content.
- `malformed-bidi-control-character` (BIDI_CONTROL_CHARACTER): detected — Content carries a U+202E right-to-left override, which mangles logical order.
- `malformed-language-script-mismatch` (LANGUAGE_SCRIPT_MISMATCH): detected — An Arabic-tagged record carries Latin-only content.
- `malformed-stale-after-from-observed-at` (STALE_AFTER_MISMATCH): detected — staleAfter is measured from observedAt rather than from write time, so an old observation is born nearly stale.
- `malformed-stale-expectation-mismatch` (STALE_EXPECTATION_MISMATCH): detected — A record whose staleAfter is in the past claims it is not stale at the clock.
- `malformed-retrievable-stale-record` (RETRIEVE_EXPECTATION_INCONSISTENT): detected — A stale record claims it is still retrievable, which retrieve() forbids.
- `malformed-unknown-supersedes-handle` (UNKNOWN_SUPERSEDES_HANDLE): detected — A record supersedes a handle that does not exist in the fixture.
- `malformed-retrieve-order` (RETRIEVE_ORDER_INVALID): detected — expectedRetrieveHandles is ordered oldest-observedAt first.
- `malformed-prune-count` (PRUNE_COUNT_MISMATCH): detected — A fixture with one stale record expects prune() to return 0.
- `malformed-vacuous-absence-assertion` (VACUOUS_ABSENCE_ASSERTION): detected — expectedAbsentFromProjection names a string that is nowhere in the DomainState.

## Fixtures by cell

- `ar` × `missing`: `ar-missing` (0 in-scope records, 1 bidirectional strings)
- `ar` × `stale`: `ar-stale` (1 in-scope records, 3 bidirectional strings)
- `ar` × `conflicting`: `ar-conflicting` (4 in-scope records, 5 bidirectional strings)
- `ar` × `sensitive`: `ar-sensitive` (2 in-scope records, 3 bidirectional strings)
- `he` × `missing`: `he-missing` (0 in-scope records, 1 bidirectional strings)
- `he` × `stale`: `he-stale` (1 in-scope records, 3 bidirectional strings)
- `he` × `conflicting`: `he-conflicting` (4 in-scope records, 5 bidirectional strings)
- `he` × `sensitive`: `he-sensitive` (2 in-scope records, 3 bidirectional strings)
- `en` × `missing`: `en-missing` (0 in-scope records, 0 bidirectional strings)
- `en` × `stale`: `en-stale` (1 in-scope records, 0 bidirectional strings)
- `en` × `conflicting`: `en-conflicting` (4 in-scope records, 0 bidirectional strings)
- `en` × `sensitive`: `en-sensitive` (2 in-scope records, 0 bidirectional strings)
- `mixed` × `missing`: `mixed-missing` (0 in-scope records, 1 bidirectional strings)
- `mixed` × `stale`: `mixed-stale` (1 in-scope records, 3 bidirectional strings)
- `mixed` × `conflicting`: `mixed-conflicting` (4 in-scope records, 8 bidirectional strings)
- `mixed` × `sensitive`: `mixed-sensitive` (2 in-scope records, 3 bidirectional strings)

---
*End of report.*