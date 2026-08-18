# Life-State & Memory Contract Fixtures

> **SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE**
>
> Every string, id, timestamp and scope in this corpus is invented for engineering QA.
> It contains no production user data, no pilot data and no V03 human evidence, and
> nothing in it may be presented as such.

Sprint 02, issue [#11](https://github.com/anasakkari3/maybesitter/issues/11). Design:
`docs/superpowers/specs/2026-08-18-sprint-02-life-state-memory-design.md`, Component 3.

## What this is

The corpus is the executable specification for two behaviours the Sprint 02 contracts
declare but cannot enforce on their own:

1. `Field<T>` semantics in `src/contracts/v1/lifeStateContracts.ts` — above all that
   *known to be zero* and *not known* are different values, and that every field carries
   provenance.
2. Runtime-memory record-status behaviour in `src/contracts/v1/memoryContracts.ts` —
   staleness, supersession, retrieval visibility and export policy.

Every fixture therefore declares the **expected decision**, not just an input. Where the
committed contracts genuinely do not determine a value, the fixture says so explicitly
(`unpinned`) rather than guessing: a vague expectation is worse than no expectation.

## Files

| Path | Purpose |
|---|---|
| `tests/fixtures/lifeStateMemoryFixtures.ts` | The corpus: 16 positive fixtures (4 languages × 4 context conditions) and 20 deliberately malformed negative cases. |
| `lib/lifeState/fixtureValidator.ts` | Validates fixture shape and internal consistency against the contracts, reusing `lib/evaluation/registry/validationPrimitives`. |
| `lib/quality/fixtureCoverageReport.ts` | Coverage report across language × context-condition, markdown + JSON, mirroring `generateMarkdownReport` in the alpha quality harness. |
| `scripts/fixture-coverage-run.ts` | CLI wrapper, following `scripts/alpha-quality-run.ts`. |
| `tests/fixtures/lifeStateMemoryFixtures.test.ts` | Validator conformance, coverage completeness, per-condition expectations, seeded-failure proof. |
| `tests/fixtures/fixtureBidiRoundTrip.test.ts` | Arabic/Hebrew logical-text preservation. |

## The matrix

Four context conditions in each of `ar | he | en | mixed`:

| Condition | LifeState expectation | Memory expectation |
|---|---|---|
| **missing** | Empty `DomainState`; every field `{ known: false, reason: 'NO_DATA' }` with `source: 'absent'`. | No in-scope records. A language-tagged probe record lives under a neighbouring scope, so an empty retrieval proves scope filtering rather than an empty store. |
| **stale** | Input roughly six months old. `commitments`, `availability` and `load` stay known with an old `derivedFrom`; `recentOutcomes` is **known-zero**, not unknown. | One record past `staleAfter`: `retrieve()` misses it, `listAll()` still shows it, `prune()` moves it to `expired`. |
| **conflicting** | Two commitments claim the same instant; both busy windows survive. One open unscheduled commitment; three open commitments band as `moderate`. | A supersession chain plus an unresolved contradiction. `retrieve()` returns the replacement and the contradiction; `listAll()` returns the whole chain including the superseded record. Carries the corpus's only `shareable_aggregate` record. |
| **sensitive** | Clinical commitment. No title, person or description may appear anywhere in the serialised LifeState. | Two clinical records, one omitting `exportPolicy` so the contract default is exercised. Both resolve to `personal_never_export`; `assertNoPersonalMemory` must throw. |

The expected decision is **language-invariant**: only ids and text change across the four
languages. A decision that varies with the language is a multilingual regression by
definition, and a test enforces this by comparing normalised expectation skeletons.

## Reading rules the corpus commits to

The contracts leave a few things open. Where a fixture must choose, it chooses once, in
the corpus header, and says why:

- **`provenance.derivedFrom`** is the newest `updatedAt` among the DomainState records
  that feed *that* field. Fields fed by open commitments only (`availability`, `load`)
  therefore carry an older `derivedFrom` than `commitments`. When nothing feeds the field
  — `recentOutcomes` with no activity inside the window — `derivedFrom` is `null` while
  `source` stays `domain_state`, because the field is known-zero rather than unknown.
- **`provenance.computedAt`** always equals the fixture clock
  (`2026-08-18T09:00:00.000Z`). A projection that reads the system clock fails every
  fixture at once.
- **Commitment id arrays** are compared as sets; the contract fixes no ordering.
  **`busyWindows`** is compared in order, ascending by `startsAt` then `commitmentId`,
  the only deterministic ordering available.
- **`staleAfter` is `putAt + ttlMs`** — measured from write time, never from `observedAt`.
  A fact observed long ago but recorded today is not born stale. The `sensitive` fixtures
  carry a record whose `observedAt` precedes its `createdAt` to pin that distinction.
- **`retrieve()`** results are ordered newest-`observedAt` first. Fixtures avoid
  `observedAt` ties so the order is total.
- **`NO_DATA` requires an empty `DomainState`.** `INSUFFICIENT_DATA` over a populated
  state is contract-legal but warned on; `NOT_IMPLEMENTED` is a silent, legitimate
  deferral.

`load.totalUrgencyScore` and `load.dueSoonCount` are deliberately **unpinned**, each with
a recorded reason: the urgency formula lives in `lib/utils/agendaScoring` and the contract
defines no "due soon" horizon. Both are owned by the projection (#9). The validator
requires every unpinned view key to carry such a reason, so an expectation can never be
quietly dropped.

## Acceptance criteria

**Arabic and Hebrew logical text is preserved.** `tests/fixtures/fixtureBidiRoundTrip.test.ts`
asserts that every corpus string is NFC-normalised, contains no bidi control character
(LRM, RLM, ALM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI), and survives both
`JSON.stringify`/`parse` and a UTF-8 file write/read byte-identically with an unchanged
code-point sequence. The RTL strings deliberately embed Latin words, ASCII digits and
Arabic-Indic digits, because a pure Arabic or Hebrew string round-trips trivially while a
bidirectional one is where reordering and control-character damage actually show up. One
test pins the code-point offset of an embedded Latin run inside an Arabic sentence across
a file round trip.

**Sensitive fields have explicit handling.** Sensitive records are marked `sensitive: true`
and must expect `personal_never_export`; the validator rejects any that do not. One
sensitive record per fixture omits `exportPolicy` so the contract default is exercised
rather than assumed. Separately, every fixture asserts that no commitment title, person or
description appears in the serialised LifeState, and the validator rejects an absence
assertion naming a string that is not in the fixture's own input, so the assertion can
never be vacuous.

**Fixtures contain no production user data.** Synthetic by construction, committed under
the QA-only header carried by every file in this component.

## Running

```bash
# Tests
node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/fixtures/lifeStateMemoryFixtures.test.ts
node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/fixtures/fixtureBidiRoundTrip.test.ts

# Coverage report -> docs/quality/reports/life-state-memory-fixture-coverage.{md,json}
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/fixture-coverage-run.ts
```

The coverage gate fails on a coverage gap, a fixture that does not validate, or a seeded
malformed fixture the validator failed to reject. The last one matters most: a validator
that cannot fail is not evidence of anything, so the negative corpus carries 20 cases,
each declaring the issue code it must trigger.

## Extending

Adding a language to `MemoryLanguage` or a condition to `ContextCondition` breaks
`tests/fixtures/lifeStateMemoryFixtures.ts` at **compile time** — the vocabularies are
exhaustive `Record<Union, true>` maps — and then fails the coverage test and the CLI gate
until fixtures exist for every new cell. The same trick guards the validator's
vocabularies against contract drift.

## Notes for later sprints

- No fixture covers the `heavy` or `overloaded` load bands. Reaching them needs six and
  ten open commitments respectively, which is fixture bulk without new behaviour; the
  banding rule itself is pinned by the validator against `LOAD_BAND_THRESHOLDS` at every
  open count.
- Reminders and escalation states are empty in every fixture. `RecentOutcomesView` is
  documented as deriving from ack states *and* reminder statuses, but the contract does
  not say how the two combine, so pinning a reminder-driven expectation would have meant
  inventing that rule. Worth revisiting once #9 lands.
- The fixtures deliberately do not import `lib/lifeState/lifeStateProjection.ts` or
  `lib/runtimeMemory/**`. A corpus that can only be validated by the code it is meant to
  hold to account is not a specification. Wiring the fixtures to the real implementations
  happens at merge time.
