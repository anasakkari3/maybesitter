# Two-Model Escalation — Execution State (paused 2026-08-21)

Paused at the owner's request. This file is the resume point.

**Plan:** `docs/superpowers/plans/2026-08-21-two-model-escalation.md`
**Integration branch:** `core-value/integration` @ `acc5142`
**Worktree:** `worktrees-core-value/integration`
**Tree:** clean. **Backend suite:** `2345 pass / 0 fail` (baseline was 2291).

---

## Task status

| Task | What | Status | Commit |
|---|---|---|---|
| 1 | Dialect eval baseline | DONE | `0e1bc47` |
| 2 | Injection boundary (own module) | DONE | `9162913` |
| 3 | Escalation gate | DONE | `0a44cd2` |
| 4 | Arbiter | DONE | `796d8fc` |
| 5 | Wire gate + arbiter into extraction path | **NOT STARTED** | — |
| 6 | Disagreement log | **NOT STARTED** | — |
| 7 | Split-choice UX | DONE | `56ea234` |
| 8 | Privacy copy | DONE | `e8ce61f` |
| 9 | Derived projection | DONE | `219268f` |
| 10 | Inference store | DONE | `1b07d88` |

All four stream branches are merged. `package.json`'s explicit test list was
reconciled by hand: 144 entries, every new test file registered exactly once
(verified). Merge order was D → A → B → C; only `package.json` conflicted.

---

## RESUME HERE: Tasks 5 and 6

They were deliberately serialised — Task 5 edits `src/extraction/extractionService.ts`,
which Stream B also edited, so it had to land after B merged. B has merged. Task 5
is now unblocked. Task 6 depends on contracts from 3 and 4, both of which exist.

Both must be done TDD, then `npm test`, then commit with the plan's exact messages.

### Task 5 — two corrections the plan text needs

**5a. The plan's test fixtures will not typecheck.** They return bare verdicts:

```ts
arbiter: async () => ({ agrees: false, correctedSplit: 2, correctedTimes: [], note: 'two' })
```

`ArbitrationVerdict` now also requires `outcome: 'agreed' | 'disagreed' | 'unavailable'`
(Task 4, deliberate deviation — see below). Every fixture in Task 5's tests needs the
`outcome` field added.

**5b. The plan's `escalated` flag reinstates the bug Task 4 was written to prevent.**
The plan says:

```ts
escalation: { escalated: gate.escalate && verdict !== null, reasons: gate.reasons, verdict }
```

A verdict from a timeout, a throw, a malformed reply, or a call the injection screen
refused is non-null and carries `outcome: 'unavailable'`. Under the plan's line those
all report `escalated: true` — i.e. "this capture got a second opinion" when it got
nothing. Use instead:

```ts
escalated: verdict !== null && verdict.outcome !== 'unavailable'
```

and add a test proving an arbiter that throws leaves `escalated === false` while
`reasons` still records why the gate fired. Otherwise Task 6's `disagreementRate`
and any escalation telemetry silently overstate coverage during an outage.

### Task 6 — one weak test to strengthen

The plan's third test:

```ts
assert.ok(!serialised.includes('note') || !serialised.includes('pronoun'), ...)
```

passes trivially — the record has no `note` key, so the left side is always true and
the assertion can never fail. Replace with a distinctive sentinel in the verdict's
`note` and assert `JSON.stringify(record)` contains neither the sentinel nor the raw
text. Also consider typing `disagreementRate(records: readonly DisagreementRecord[], …)`
rather than `readonly unknown[]`.

---

## Findings from the four streams that outlive this plan

These are real defects the streams proved, not opinions. None are fixed.

**F1 — BLOCKING for the plan's model choice. `callOllama` cannot read thinking models.**
`src/extraction/localLLMProvider.ts` reads only `data.response` and never sends
`"think": false`. `guoxuter/ov_intent_analysis_sft:v7_q8` and `qwen3.5:9b` are both
thinking-capable: Ollama puts their answer in `thinking` and leaves `response` empty,
so every call returns `''` and scores 0. Verified directly with curl — the same call
with `"think": false` returns real JSON from both. **The 0/8 Arabic scores in
`evaluation-reports/dialect-baseline.json` measure the client, not the models**, and
the model the plan designates for production is among them. Separately, that model's
output schema (`{"action": …, "parameter": {…}}`) is nothing like `ExtractionResult`,
so it will still fail schema validation after the `think` fix.

**F2 — The dialect eval's time scoring is timezone-naive.** `expectedTimes` are local
wall-clock (Asia/Jerusalem) but `schemaValidator` normalises `dueAt` through
`toISOString()`. At UTC+3 a *correct* local 05:00 serialises as `02:00Z`, so the
substring check fails on right answers — and passed `he-1` on an answer that was three
hours wrong. The 3 cases carrying `expectedTimes` are unscorable on the time half.

**F3 — The dataset is 8 of 50.** The 42 owner-authored dialect cases do not exist.
`ESCALATION_THRESHOLDS = { time: 0.6, overall: 0.7 }` are therefore PROVISIONAL, and
the doc comment on them says so. Four Arabic sentences cannot calibrate a threshold.

**F4 — `extractWithOllama` calls the model twice and screens neither.** Rows 2 and 3 of
the model-call inventory: the extract call and the repair call both receive raw text,
and the only injection screen sits in `extractWithFallback`, one level up. Any future
caller reaching `extractWithOllama` directly bypasses the boundary. Same shape at
`captureBoundaryService.ts:75` and `mobile/safety.ts:27`, where `dependencies.extractor`
is injectable.

**F5 — Task 7's `buildSplitChoice` is a boundary primitive, not shipped UX.** Zero
production callers (`grep` finds it only in its own file and its test). `CaptureResult`
(`mobile/lib/models/capture_result.dart:74-85`) and `CaptureProposalResponseDto`
(`proposal_dtos.dart:88-91`) carry no second reading, verdict, or escalation field —
there is no wire format that could deliver a remote verdict to the phone. Wiring it is
out of this plan's scope and was correctly not invented.

**F6 — `privacyEscalationNote` is written but never rendered.** It has no render site;
whoever enables escalation must surface it. The plan's proposed copy promised remote
deletion (`تُحذف بعدها`) which nothing in the repo can guarantee — and its proposed
replacement ("analysed on your device first") is also false, since
`api_capture_service.dart:22-28` posts raw input to `/api/mobile/capture` whenever
`API_BASE_URL` is set. Shipped copy states both cases honestly and explicitly
disclaims deletion.

**F7 — Stale duplicate localisations.** `mobile/lib/l10n/app_localizations*.dart`
(top-level) are git-tracked, never imported (`l10n.yaml` generates into
`lib/l10n/generated/`), and still contain the old `بخصوصية تامة` promise. Dead, but
exactly the kind of file that gets resurrected. Delete in a separate cleanup.

**F8 — `npm test` dirties the tree.** Every run rewrites
`evaluation-reports/capture-gate-test-report.json` (timestamp + p95 only). All three
streams had to `git checkout --` it before committing. Pre-existing.

**F9 — Pre-existing typecheck error.** `npx tsc --noEmit` reports one error in
`lib/analytics/privacySafeEvents.ts` (TS2740). Untouched by this work, present at
baseline.

**F10 — The plan's `npx tsx --test` command does not work here.** `tsx` is not
installed. The project's real runner is
`node --no-warnings --loader ./scripts/ts-resolver.mjs --test <file>`.

**F11 — Plan fixtures use `{…} as ExtractionResult`, which fails `tsc --strict`**
(missing `explicitReminderRequest`, `explicitPressureRequest`, `rawText`,
`parserVersion`). Affects the fixtures in Tasks 3, 4 and 5. Complete the fields;
do not weaken with `as unknown as`.

---

## Deliberate deviations already landed (do not "fix" back)

1. **`ArbitrationVerdict.outcome`** — added so a timeout/throw/malformed/blocked call is
   never reported as "the two models agreed". `agrees` keeps its meaning, so Task 5's
   intended behaviour is unchanged. Derived locally, never read off the wire: a model
   cannot label its own correction an agreement.
2. **`projectionIsSendable` strengthened** — the plan's one-line body checked only the
   observation count while its name and comment claimed it enforced the no-text rule.
   Now calls `projectionCarriesNoText()` first. Closed a real leak: `ProjectionEvent.kind`
   is typed `string` and `byKind` keys shipped verbatim, so a title in `kind` walked
   straight through. `buildDerivedProjection` now buckets non-slug kinds into `'other'`.
3. **`createEntry` accepts six sources, not three** — the plan's three could only ever
   produce FACT/OBSERVATION/INFERENCE, leaving PREFERENCE/GOAL/CONSTRAINT unreachable in
   data.
4. **`promoteToFact` promotes only INFERENCE and OBSERVATION.** PREFERENCE, GOAL and
   CONSTRAINT keep their class on confirmation — they are different kinds of statement,
   not weaker facts, and downstream logic dispatches on the difference.
5. **`buildSplitChoice` compares times, not just counts** — the plan's
   `remote.length == local.length` called two readings that disagree about *when*
   an agreement. It also treated a blank-titled remote entry as a real dispute.
6. **Task 8 copy rewritten in all three locales** — see F6.

---

## Still open from earlier work (unrelated to this plan)

- Watch app blocked: provisioning profile lacks Watch UDID `00008310-0000E90411D1A01E`.
- Pressing Aware/Snooze/Done on a real notification needs a human touch.
- Readiness checklist 8/11 open (operational decisions).
- `RevokeTrust` semantics — asked, never answered.

## Note for final integration

`main` has moved to `4fa5b9d` (Sprint 10 merged) since this branch forked at `e258533`.
Rebase or merge before any PR. Sprint 08 remains off-limits.
