# Two-Model Escalation — Completion Report (2026-08-21)

> **Historical — do not follow these commands.** This document dates from the
> retired Flutter client, when `mobile/**` was the Flutter app. **`mobile/` is
> now the React Native application.** Any `flutter` command below refers to the
> archived client at tag `archive/flutter-final`, not to anything on `main`.
> See `docs/migration/flutter-to-rn-parity.md` (UC-2.R5, #175).

**Plan:** `docs/superpowers/plans/2026-08-21-two-model-escalation.md`
**Branch:** `core-value/integration` @ `aedddf9` (forked from `e258533`)
**Worktree:** `worktrees-core-value/integration`

## A. Scope

All 10 tasks of the plan. Four parallel agent worktrees (Tasks 1+3, 2+4, 9+10,
7+8), then Tasks 5 and 6 at integration because Task 5 edits the same file as
Task 2. Sprint 08 was not touched.

## B. Status

| Task | Deliverable | Commit |
|---|---|---|
| 1 | Dialect eval baseline | `0e1bc47`, re-measured in `aedddf9` |
| 2 | Injection boundary module | `9162913` |
| 3 | Escalation gate | `0a44cd2`, corrected in `aedddf9` |
| 4 | Arbiter | `796d8fc`, hardened in `aedddf9` |
| 5 | Gate + arbiter wired into the extraction path | `c9b453d`, corrected in `aedddf9` |
| 6 | Disagreement log | `abbd182`, corrected in `aedddf9` |
| 7 | Split-choice UX | `56ea234`, corrected in `aedddf9` |
| 8 | Privacy copy | `e8ce61f` |
| 9 | Derived projection | `219268f`, corrected in `aedddf9` |
| 10 | Inference store | `1b07d88` |

## C. Verification

- Backend: `npm test` → **2389 pass, 0 fail** (baseline at fork: 2291).
- Mobile: `flutter test` → **441 pass, 1 skipped**; `flutter analyze` → clean.
- `npx tsc --noEmit` → one error, pre-existing, in `lib/analytics/privacySafeEvents.ts`.
- 146 test files registered in `package.json`'s explicit list, zero duplicates,
  zero registered-but-missing.

## D. Review

Three independent reviews (spec conformance, security/privacy, code quality),
none by the implementers. Every finding in this branch's own code was fixed and
is covered by a test that fails without the fix. Findings outside this branch's
code are recorded in §G and were deliberately not touched.

## E. Defects found by review and fixed

1. **Refused captures were escalated.** `arbitrate()` excluded only the
   injection path, so a sentence the semantic-safety gate discarded — creating
   nothing for the user — was still sent to the remote provider. Demonstrated
   with `'I saw her yesterday at the clinic'`.
2. **An Ollama outage escalated everything.** The rule-based fallback caps
   `overall` at 0.68 and `time` at 0.1, both under the gate, so the outage that
   costs the cheap path would have maximised both spend and disclosure. The
   arbiter now judges model proposals only (`engine === 'ollama'`).
3. **The arbiter prompt interpolated raw text.** No fencing, no escaping, no
   "this is data" instruction — weaker containment than the local path, on the
   call that sees the most sensitive text. Now matches `buildPrompt`.
4. **`projectionCarriesNoText` was defeated by `toJSON`.** The guard reads
   `Object.keys`; `JSON.stringify` ignores those when `toJSON` exists, and a
   prototype method is invisible to `Object.keys`. A class instance passed the
   guard and serialised titles and a person's name. Now requires a plain object.
5. **`byKind['constructor']` produced a string count.** `{}['constructor']` is
   not `undefined`, so `?? 0` never fired. Now `Object.create(null)`.
6. **`recordDisagreement` trusted an injected verdict.** `options.arbiter` is
   caller-supplied and types are erased at runtime, so `correctedSplit` could
   carry a sentence. Now narrowed to a count and a language tag.
7. **No timeout and no input cap on the remote call**, while the local path has
   both. Now 10s and 4000 chars.
8. **`ARBITRATION_UNAVAILABLE` was a shared mutable singleton** returned by
   reference from five paths. Now frozen.
9. **The gate missed the plan's own `ar-3` fixture.** `نفس (الموعد|...)`
   requires the article; `نفس موعد الأسبوع الماضي` is construct state.
10. **The gate fired on Arabic substrings.** JS `\b` is ASCII-only, so `عنده`
    matched inside `عندهم` and `معه` inside `الجامعه`. Now uses lookarounds.
11. **Bare English pronouns escalated 7 of 11 ordinary captures** for no signal
    — they change no extracted field and the arbiter has no history either.
    Removed; the Arabic preposition+clitic forms, which do carry an unnamed
    destination, are kept.
12. **`callOllama` never sent `think: false`** and read only `response`.
    Thinking models answer in `thinking`, so every call returned `''`. **This,
    not dialect difficulty, is why two candidates scored 0/8.**
13. **The eval scored local wall-clock against UTC** by substring. A correct
    Asia/Jerusalem 05:00 (`02:00Z`) failed; an answer three hours off passed
    because `08:00Z` contains `08:00`. Now compares `localClock()` exactly.
14. **The mobile clock parser could not read `'7:00 PM'`**, which
    `soft_awareness_reminder_engine` and `commitment_edit_sheet` both write. A
    null read as "pins no time", so `'7:00 PM'` vs `'19:00'` silently shipped
    the local guess — the exact AM/PM case the module exists to catch.
15. **The midnight artefact guard missed the default granularity.**
    `TimeGranularity` defaults to `exact`, so a date with no clock was read as
    a 00:00 claim and manufactured disputes.
16. **The eval harness called the model without the injection screen** — added
    by this plan, in Task 1. Now screened.
17. Three tests that could not fail were replaced, and one whose name and
    comment described a fixture it did not use was corrected.

## F. Re-measured baseline

After fixing #12 and #13, `evaluation-reports/dialect-baseline.json`:

| model | overall | ar | he | en |
|---|---|---|---|---|
| `guoxuter/ov_intent_analysis_sft:v7_q8` | 4/8 | **3/4** | 1/2 | 0/2 |
| `gemma3:4b` | 4/8 | **3/4** | 1/2 | 0/2 |
| `qwen3.5:9b` | 6/8 | **3/4** | 1/2 | 2/2 |

All three tie on Arabic. The previous report's 0/8 figures are marked
`supersedes` in the file and must not be cited. The dataset is still 8 of 50;
`ESCALATION_THRESHOLDS` stays provisional.

## G. Outside this plan's code

> **Update 2026-08-22:** G1 and G2 are fixed on branch
> `fix/alpha-trace-session-isolation` (worktree
> `worktrees-core-value/alpha-trace-hardening`, commits `62d3ce9` and `970b9af`),
> based on `main` rather than this branch so a critical security fix is not
> gated behind work marked NOT READY. Full suite there: 2851 pass, `tsc` clean.
> G3–G7 remain open.


**G1. FIXED (`fix/alpha-trace-session-isolation`). CRITICAL, remotely exploitable: alpha trace session hijack.**
`sessionId` comes from the request body (`lib/alphaTrace/traceRecorder.ts:40-45`)
with no charset check, and `alphaTraceStore.append` overwrites `participantId`
while preserving the existing `stages`. An enrolled participant can read another
participant's raw capture text via `/api/mobile/alpha/trace`. The same rewrite
defeats deletion: `deleteParticipant` matches on the field the attacker changed,
so the victim's data survives their own deletion request. Gated behind
`MAYBESITTER_ALPHA_TRACE_ENABLED`, which `docs/alpha/reviewable-trace.md`
describes enabling for alpha review. Fix: reject `sessionId` not matching
`/^[A-Za-z0-9_-]{1,128}$/`, and refuse an `append` whose `participantId` differs.

**G2. FIXED (`fix/alpha-trace-session-isolation`). CRITICAL: path traversal.** The same unvalidated `sessionId` is the
filename (`alphaTraceStore.ts:36-38`), giving arbitrary file write outside the
data dir with attacker-influenced content.

**G3. HIGH: `detectPromptInjection` is bypassable in all three languages.**
15 of 15 crafted payloads passed, including tatweel and harakat inside `تجاهل`,
the Hebrew imperative `תתעלם` (not a superstring of `התעלם`), a newline (the
pattern has no `/s`), and filler past the 50-character window. One branch
requires the *English* word `ignore` next to `التعليمات`. It also over-blocks
benign captures containing a code fence or `---`. Denylisting inflected Semitic
morphology with literal regexes cannot work; treat the screen as advisory.

**G4. `extractWithOllama` makes two model calls and screens neither.** The screen
lives one level up in `extractWithFallback`. Same shape at
`captureBoundaryService.ts:75` and `mobile/safety.ts:27`, where the extractor is
injectable. `captureBoundaryService` also segments text *before* screening, so
the screen only ever sees fragments.

**G5. Raw `inputText` is persisted for 30 days** when tracing is on
(`src/app/api/mobile/capture/route.ts:27`). No shipped string discloses this.

**G6. 7 test files are in no npm script** (`tests/memory/*`, 71 tests). All pass;
this is silent coverage loss. Pre-existing at the fork.

**G7. Stale duplicate localisations.** `mobile/lib/l10n/app_localizations*.dart`
(top level) are tracked, unimported, and still promise "complete privacy".

## H. Known limitations of what was built

**H1. The feature is not reachable from production.** Every production caller
uses `extractWithFallback`; only `extractAndMap` calls `arbitrate`. Nothing
constructs an Anthropic client anywhere. `src/personality/*`,
`recordDisagreement` and `buildSplitChoice` have no production callers either,
and `CaptureResult` / `CaptureProposalResponseDto` carry no field that could
deliver a remote verdict to the phone. The plan asked for the primitives; wiring
them is a separate piece of work.

**H2. `recordDisagreement` has no call site and structurally cannot get one yet**
— `extractAndMap` has neither the `id` nor the `language` it requires.

**H3. `privacyEscalationNote` is written in all three locales but never rendered.**
Whoever enables escalation must surface it. There is also no consent gate for
escalation anywhere.

**H4. The thresholds rest on 4 Arabic sentences.** 42 owner-authored cases are
still needed.

## I. Deliberate deviations from the plan text

1. `ArbitrationVerdict.outcome` — so a timeout/throw/malformed/refused call is
   never reported as "the two models agreed". Derived locally, never off the wire.
2. `projectionIsSendable` strengthened — the plan's body checked only a count
   while its name promised a no-text guarantee.
3. `createEntry` accepts six sources — the plan's three left three provenance
   classes unreachable in data.
4. `promoteToFact` promotes only INFERENCE and OBSERVATION — PREFERENCE, GOAL
   and CONSTRAINT are different kinds of statement, not weaker facts.
5. `buildSplitChoice` compares times, not just counts.
6. Task 8 copy rewritten — the plan promised remote deletion nothing can
   guarantee, and its own replacement ("analysed on your device first") is false
   whenever `API_BASE_URL` is set.
7. `disagreementRate` throws when records exceed captures, and no longer rounds.
8. `ExtractionEscalation.unavailableReason` added — a misconfigured arbiter
   otherwise reports clean zeros on every capture.
9. `runDialectEval` reads the model from the environment instead of taking a
   label that could disagree with the model actually called.

## J. Plan-text errors worth correcting before anyone else follows it

- `npx tsx --test` does not work here; `tsx` is not installed. The real runner is
  `node --no-warnings --loader ./scripts/ts-resolver.mjs --test <file>`.
- Fixtures written as `{…} as ExtractionResult` fail `tsc --strict` (Tasks 3, 4, 5).
- Task 1 never registers its test file in `package.json`.
- Task 6's third test is a tautology as written.

## K. Verdict

**NOT READY** — for turning the feature on. The plan is fully implemented,
tested and independently reviewed, and every defect the reviews found in this
branch is fixed. It must not be wired until, at minimum: G1 and G2 are merged (they are fixed
on `fix/alpha-trace-session-isolation` but not yet on `main`),
`privacyEscalationNote` has a render site and a consent gate, and the escalation
path has an owner-approved cost model. The branch itself is sound to merge as
primitives.

Note: `main` has moved to `4fa5b9d` since this branch forked at `e258533`.
