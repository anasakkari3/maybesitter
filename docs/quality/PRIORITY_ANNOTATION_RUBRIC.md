# Priority Annotation Rubric

Sprint 04, issue [#19](https://github.com/anasakkari3/maybesitter/issues/19).
Status: **authored specification — not collected from raters.**

> **SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE**
> Every commitment quoted in this document and in `tests/fixtures/prioritySeedSet.ts` is invented
> for engineering QA. No production user state, pilot data, or runtime memory appears anywhere in
> the seed set or in this rubric.

## 0. What this document is, and what it is not

This is the **scoring spec a human annotator follows**. It is written before any annotation happens,
by engineering, so that annotators are told the criteria rather than asked to invent them.

It is **not** a record of any human judgment. As of this sprint **zero pairwise judgments exist**.
The judgment corpus (`data/quality/priority-judgments.json`) ships **empty and wired**: the schema,
the loader, the validation and the agreement math are all present and tested, and the file contains
no rows. `AgreementReport.corpusEmpty` exists precisely so a report over an empty corpus says so
instead of presenting zeros as measurements.

Nothing in the seed set carries an expected verdict. A pre-filled "correct answer" *is* the human
judgment this sprint does not have, so recording one would be fabricating the deliverable.

## 1. The annotation task

You are shown **one pair of commitments**, `left` and `right`, drawn from the same simulated user at
the same instant.

> **The question.** *If the agenda could show only one of these two next, which one should it be?*

You answer with exactly one of four verdicts:

| Verdict | Means |
|---|---|
| `left` | `left` should be shown above `right`. |
| `right` | `right` should be shown above `left`. |
| `tie` | The rubric applies and yields **equal standing** — either order is equally acceptable. |
| `unresolved` | The rubric **does not determine** an answer. See §4. |

`tie` and `unresolved` are not synonyms, and confusing them is the single most damaging annotation
error. `tie` is a *finding*: the criteria were applied and came out level. `unresolved` is an
*abstention*: the criteria could not be applied. §4 gives the test that separates them.

### 1.1 What you may use

Each pair gives you, for both sides:

- title, description, person, language;
- status and acknowledgement state;
- the time spec (`dueAt` / `remindAt`) **relative to the pair's fixed clock**, which is always
  `2026-08-18T09:00:00.000Z`;
- reminder history (delivered, snoozed, ignored);
- the priority level and **whether the user set it themselves** (`user_explicit`) or the system
  inferred it (`inferred` / `default`);
- the surrounding **load pattern** — how many other open commitments this user is carrying.

### 1.2 What you may not use

- **Anything about the user that the pair does not state.** Do not imagine a job, a family
  situation, a health condition, or a cultural obligation that is not written down. If you find
  yourself needing one to decide, that is criterion `U2` in §4 and the verdict is `unresolved`.
- **Effort and dependency.** The product does not record how long a commitment takes or what it
  blocks (`PriorityFeatures.dependency` and `.effort` are permanently unknown in v1). "The short one
  first" and "that one unblocks the other" are therefore both out of scope. If effort or dependency
  is the only thing that would separate the pair, the verdict is `unresolved` (`U3`).
- **The language of the item.** A commitment written in Arabic, Hebrew, English or a mix must be
  ranked exactly as its English translation would be. A verdict that changes when the language
  changes is a multilingual regression, and the seed set is built in matched cells specifically so
  that this is measurable.
- **Your own preference about the domain.** "Medical things always come first" is a rule you are
  importing. If you believe the rubric is missing such a rule, record `unresolved`, say so in the
  rationale, and file it — §7 covers how rubric gaps get fixed.

## 2. The decision procedure

Apply the criteria **in order**. The first criterion that separates the pair decides it. Stop there;
do not keep going to see whether a later criterion would have said something else.

This is a lexicographic order, not a weighted sum, and that is deliberate: a weighted sum asks an
annotator to invent exchange rates between incommensurable things, and annotators invent different
ones. The engine's scoring policy (#18) does use weights — the rubric exists to check that policy
against human ordering, so the rubric must not simply restate it.

---

### C1 — Deadline already passed beats deadline not yet passed

If exactly one side is **overdue** (its `dueAt` is before the clock), that side ranks higher.

*Why first:* an overdue commitment has already failed its own time constraint; the harm from
delaying it further is already accruing, while the other side's is not.

**Exception (C1a).** If **both** sides are overdue, C1 does not separate them — go to C2. Do **not**
prefer the more overdue side here; that is C4's job, after importance.

---

### C2 — Closer deadline beats further deadline, within the same overdue status

If neither side is overdue, or both are:

- **Both overdue:** C2 does not apply. Go to C3.
- **Neither overdue:** the side whose next time (`dueAt`, else `remindAt`) is **sooner** ranks
  higher — but only if the gap is **more than 4 hours**. Inside 4 hours the two are treated as
  simultaneous and C2 does not separate them.
- **One side has no time at all** (`kind: 'unscheduled'`, both `dueAt` and `remindAt` null) and the
  other has one: the **timed** side ranks higher.

*Why the 4-hour dead band:* without it, annotators split on differences of minutes that no user
experiences as a difference, and the disagreement they generate is noise that Sprint 05 would
calibrate against.

---

### C3 — User-set importance beats inferred importance

Compare `priority.level` (`high` > `normal` > `low`), but weight the **source**:

1. If one side is `high` **and the user set it themselves** (`priority.source: 'user_explicit'`) and
   the other is not, the user-set side ranks higher.
2. Otherwise, if the levels differ, the higher level ranks higher.
3. If the levels are equal, C3 does not separate them.

*Why source matters:* an inferred `high` is the system's guess. Letting a guess outrank a
commitment the user personally marked important inverts exactly the relationship this rubric is
meant to protect.

---

### C4 — Repeated delay beats first encounter

The side that has been **delayed more** ranks higher. Delay evidence, in decreasing strength:

1. snoozed reminders (count them);
2. an explicit postponement (`currentAckState: 'postponed'` or a non-null `postponedUntil`);
3. `status: 'deferred'`.

A side with strictly more snoozes ranks higher. With equal snoozes, a postponed side outranks a
non-postponed one. With both equal, a deferred side outranks a non-deferred one.

*Why:* a commitment that keeps being pushed is a commitment the user keeps failing to act on, and
burying it further is how it is eventually missed entirely. This is also the criterion an annotator
most often wants to invert ("they clearly don't want to do it") — do not. That reading is a product
decision, not an annotation, and it is out of scope here.

**C4a — most-overdue tie-break.** If both sides are overdue and C3 and the delay evidence above are
all level, the side that is overdue by more ranks higher, provided the difference is **more than 24
hours**. Under 24 hours, C4a does not separate them.

---

### C5 — Recently ignored beats not ignored

If exactly one side has an **ignored** reminder, or `currentAckState: 'ignored'`, within the last
**24 hours** of the clock, that side ranks higher.

An ignore **older** than 24 hours is weaker evidence and separates the pair only if neither side has
a recent one and exactly one side has a stale one.

*Why last:* an ignore is ambiguous — it can mean "not now" as easily as "I keep missing this". It is
in the rubric because the engine uses it, and it is last because it is the weakest of the signals
the engine uses.

---

### C6 — Nothing separates them

If C1–C5 all pass without separating the pair, the answer is **`tie`**, not `unresolved` — provided
none of the §4 abstention conditions fired along the way. The rubric applied cleanly and found the
two items level. Record `tie` and say in the rationale that you reached C6.

---

## 3. Load pattern: context, never a criterion

Every pair states the user's load band — `light`, `moderate`, `heavy`, `overloaded` — derived from
their open-commitment count (`LOAD_BAND_THRESHOLDS`: ≤2 light, ≤5 moderate, ≤9 heavy, above that
overloaded).

Load **does not change the ordering criteria**. It is in the seed set because the *cost of getting
the order wrong* rises with load: at `light` the user sees everything anyway, at `overloaded` the
item you rank second may never be seen at all. It is there so that the eventual agreement report can
show whether annotators hold together under load, and so a future policy change can be evaluated
where it matters most.

Do not use load as a tie-break. "They're overloaded so show the easy one" is an effort judgment
(§1.2) wearing a disguise.

## 4. When to record `unresolved`

Record `unresolved` — do **not** force a preference — whenever any of these fires. The rationale
must name which one.

**U1 — Criteria conflict with no precedence.** Two criteria at the same rank point opposite ways and
the procedure gives no ordering between them. In practice this arises inside a single criterion:
e.g. in C4, one side has more snoozes and the other is postponed *and* deferred. If you cannot say
which sub-signal wins without inventing a rule, abstain.

**U2 — The answer depends on facts the pair does not state.** You can name a specific missing fact
that would decide it ("whether the clinic reschedules", "whether the landlord already replied"). Say
which fact.

**U3 — The answer depends on effort or dependency.** Explicitly separated from U2 because these two
are *structurally* absent from the product, not merely missing from this pair. A U3 pair will still
be undecidable after any amount of extra state, until the contract gains those fields.

**U4 — The pair is malformed.** Contradictory state (a completed commitment with a future reminder,
a `dueAt` before `createdAt`), text you cannot read, an empty title. Abstain and report it; this is
a corpus defect, not an annotation.

### 4.1 The test that separates `tie` from `unresolved`

> Ask yourself: **would a coin flip be fine?**
>
> - Yes, the user is equally well served either way → **`tie`**.
> - No — one of them really is more urgent and I cannot tell which → **`unresolved`**.

`tie` asserts equivalence. `unresolved` asserts ignorance. They must not be merged, because they
have opposite consequences downstream: a `tie` says the policy may order these two however it
likes, and an `unresolved` says the policy's ordering of these two has not been checked at all.

### 4.2 What `unresolved` does to the agreement number

**An `unresolved` verdict is excluded from the observed-agreement denominator entirely.** It counts
as neither agreement nor disagreement. It is reported separately as `unresolvedCount`, and the
number of pairs that could not be scored appears next to the agreement figure so the coverage of the
number is always visible beside it.

The two rejected alternatives, and why:

- *Counting two `unresolved` verdicts as agreement.* This makes abstention the cheapest way to
  raise the score. Two annotators who both give up on a pair have demonstrated nothing about whether
  they would rank it the same way, and an agreement metric that rewards giving up will be maximised
  by giving up.
- *Counting `unresolved` against agreement.* This penalises annotators for following §4 correctly
  and pushes them to guess, which converts honest abstention into fabricated preference — the exact
  failure this whole track exists to avoid.

Excluding abstentions costs something and the cost is stated rather than hidden: agreement is
computed over a **subset** of the corpus, so it must always be read together with
`unresolvedCount`, `scorablePairCount` and `unscorablePairCount`. A high agreement rate over four
scorable pairs out of forty is not a high agreement rate; it is a rubric that nobody could apply,
and the report is built so that this is impossible to miss.

## 5. Worked examples

All examples use the pair clock `2026-08-18T09:00:00.000Z`. Pair ids refer to
`tests/fixtures/prioritySeedSet.ts`.

### 5.1 `ps-ar-light-01` — C1 decides, and stops

| | left `ar-light-a` | right `ar-light-b` |
|---|---|---|
| title | تسليم تقرير الحضانة | تأكيد موعد طبيب الأسنان |
| `dueAt` | 2026-08-17T13:00Z (**20h overdue**) | 2026-08-18T15:00Z (in 6h) |
| priority | `normal`, inferred | `high`, **user_explicit** |
| snoozes | 0 | 0 |

**C1**: exactly one side is overdue → **`left`**. Stop.

The instructive part is what does *not* happen. The right side is `high` and the user set it
themselves, which under C3 would have won. C1 outranks C3 and the procedure stops at the first
separating criterion, so C3 is never reached. An annotator who reaches for "but they marked the
dentist important" has run the criteria out of order. If you think C1 should *not* beat a user-set
`high`, that is a rubric change (§7), not a verdict.

### 5.2 `ps-he-heavy-01` — C6, an honest `tie`

| | left `he-heavy-a` | right `he-heavy-b` |
|---|---|---|
| title | לסדר את מסמכי הביטוח | להחזיר ספרים לספרייה |
| status | `pending_confirmation` | `pending_confirmation` |
| time | unscheduled | unscheduled |
| priority | `normal`, inferred | `normal`, inferred |
| snoozes / ignores | 0 / 0 | 0 / 0 |

C1 no (neither overdue). C2 no (neither timed). C3 no (identical). C4 no. C5 no. → **C6: `tie`**.

Coin flip is fine: both are unscheduled `normal` items with no history, and the user is equally
well served either way. This is not ignorance, it is a finding of equal standing.

### 5.3 `ps-en-overloaded-01` — C4 decides after C3 declines

| | left `en-overloaded-a` | right `en-overloaded-b` |
|---|---|---|
| title | Send the signed lease back to Daniel | Book the annual eye test |
| `dueAt` | null (`active`, unscheduled) | null (`pending`, unscheduled) |
| priority | `normal`, inferred | `normal`, inferred |
| snoozes | 3 | 0 |
| postponed | yes (`postponedUntil` set) | no |

C1 no. C2 no (neither timed). C3 no (levels equal). **C4**: left has three snoozes against zero →
**`left`**. Stop.

Load is `overloaded` here, and it changes nothing about the criteria — but it is why this pair is in
the set. On an overloaded agenda the item ranked second may never be reached at all, so a C4 error
here costs the user a commitment; the same error at `light` costs them a scroll.

### 5.4 `ps-mixed-moderate-02` — `unresolved` under U3

| | left `mixed-moderate-c` | right `mixed-moderate-d` |
|---|---|---|
| title | تحديث CV قبل مقابلة الاثنين | Prepare slides לפגישת הצוות |
| `dueAt` | 2026-08-17T18:00Z (**15h overdue**) | 2026-08-17T21:00Z (**12h overdue**) |
| priority | `high`, user_explicit | `high`, user_explicit |
| snoozes | 1 | 1 |
| postponed | no | no |

C1a: both overdue, does not separate. C2 does not apply. C3: both `high`, both user-set — level.
C4: one snooze each, neither postponed nor deferred — level. **C4a**: the overdue difference is 3
hours, under the 24-hour threshold — does not separate. C5: no ignores.

The procedure now reaches C6 and would return `tie` — but a coin flip is **not** fine. These are two
substantial pieces of preparation for two different meetings, and which one to do first genuinely
depends on how long each takes and whether the slides block a colleague. That is effort and
dependency: **`unresolved` (U3)**.

Rationale to record: `U3 — separable only by relative effort / whether slides block others; neither
is recorded in v1.`

This example is the reason §4.1 exists. C6 is reached by exhausting the criteria; `unresolved` is
reached by recognising that exhausting them did not settle the question.

### 5.5 `ps-ar-moderate-02` — `unresolved` under U1

| | left `ar-moderate-c` | right `ar-moderate-d` |
|---|---|---|
| title | متابعة طلب الإجازة مع سارة | مراجعة عقد المورّد |
| time | unscheduled | unscheduled |
| priority | `normal`, inferred | `normal`, inferred |
| snoozes | 2 | 0 |
| postponed | no | yes |
| deferred | no | yes (`status: 'deferred'`) |

C1–C3 do not separate. **C4** fires but does not resolve: left has strictly more snoozes, which
points left; right is both postponed *and* deferred, which points right. C4's sub-signals are
ordered only when the stronger one is level, and here it is not.

**`unresolved` (U1)**. Rationale: `U1 — C4 conflict: 2 snoozes (left) vs postponed+deferred
(right); no precedence rule between them.`

Do not resolve this by counting: "two snoozes beat two other flags" is arithmetic the rubric does
not authorise. If this conflict shows up often in real annotation, the fix is to add a precedence
rule to C4 and re-annotate — not to let each annotator invent one privately, which is precisely how
a rubric produces a high-variance corpus that looks fine in aggregate.

### 5.6 `ps-he-overloaded-01` — C2's unscheduled rule

| | left `he-overloaded-a` | right `he-overloaded-b` |
|---|---|---|
| title | לחדש את הרישיון עד סוף החודש | לבדוק הצעות מחיר לתיקון הרכב |
| `dueAt` | 2026-08-17T12:00Z (**21h overdue**) | null (`pending`, unscheduled) |
| priority | `low`, default | `high`, user_explicit |

**C1**: left is overdue, right is not → **`left`**. Stop.

C1 beats C3 again, and here it does so against a `low`/`default` item beating a user-set `high`,
which feels wrong to most annotators on first reading. It is intended. A passed deadline is a
constraint the world has already imposed; importance is a preference. The pair is in the locked
split precisely because it is the sharpest test of whether an annotator follows the written order
or their instinct.

## 6. Annotator protocol

1. **Independence.** Every pair is judged by at least **two** annotators who do not see each other's
   verdicts or rationales. Agreement computed over non-independent judgments measures nothing.
2. **One pair at a time**, in the order given. Do not go back and "make it consistent" — a corpus
   retro-fitted for consistency reports an agreement number that was manufactured, not observed.
3. **Rationale is mandatory** on every verdict, including `tie`, and must **name the criterion
   code** that decided it (`C1`…`C6`) or the abstention code (`U1`…`U4`). The loader rejects a
   judgment with an empty rationale. A verdict without a criterion cannot be audited, and a corpus
   that cannot be audited cannot be trusted.
4. **The locked split is not for tuning.** Pairs marked `split: 'locked'` are held out and
   checksum-protected (§8). Do not use them to iterate on the policy; the moment you do, they stop
   measuring anything.
5. **Report rubric gaps rather than absorbing them.** If you keep hitting the same U1, say so. That
   is the rubric failing, and it is fixable — silent private tie-breaks are not.

## 7. Changing this rubric

The rubric and the judgments are versioned together. Judgments collected under one version of §2
are not comparable with judgments collected under another, so a change to the criteria means:

1. bump `RUBRIC_VERSION` in `tests/fixtures/prioritySeedSet.ts`;
2. record which criterion changed and why, here;
3. treat existing judgments as belonging to the previous version — do **not** silently reuse them.

## 8. The locked evaluation split

A subset of the seed set is marked `split: 'locked'` and is the held-out evaluation split. Its
contents are pinned by a sha256 checksum over the canonical JSON of the split, recorded in
`data/registry/priority-seed-set.lock.json` and verified by `lib/priority/rubric/seedSetLock.ts`.

This follows the existing lock idiom in `lib/evaluation/registry/**` rather than inventing a second
one: the same `checksumOf(canonicalJson(...))` fingerprint, and the same append-only chain checksum,
so that a row cannot be edited in place to match a modified split. Changing a locked pair requires
appending a supersession row, which is visible in review; editing one silently is not expressible.

Editing a locked pair after judgments exist would silently change what those judgments refer to.

## 9. Current status

| Deliverable | State |
|---|---|
| Rubric (this document) | present |
| Seed set, 20 pairs, 4 languages × 4 load patterns | present, `tests/fixtures/prioritySeedSet.ts` |
| Locked split checksum | present, `data/registry/priority-seed-set.lock.json` |
| Judgment schema, loader, validation | present, `lib/priority/rubric/agreementReport.ts` |
| Agreement math | present and tested over synthetic test-only inputs |
| **Human judgments** | **zero rows — none have been collected** |

### 9.1 How a future maintainer supplies real judgments

1. Recruit at least two annotators. Have each read this document in full.
2. Run them independently over `PRIORITY_SEED_PAIRS`, per §6.
3. Append one row per (pair, annotator) to the `judgments` array in
   `data/quality/priority-judgments.json`, matching `PairwiseJudgment` in
   `src/contracts/v1/priorityContracts.ts`.
4. Run `node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-agreement-run.ts`.
   The loader rejects malformed rows; the report writes to `docs/quality/reports/`.
5. **Replace the zero-row assertion in `tests/priority/prioritySeedSet.test.ts` in the same commit
   that adds the first real rows**, and say in the commit message who annotated, when, and under
   which rubric version. Replace it rather than delete it: the guard becomes an assertion that the
   corpus matches the annotation run it claims to come from — an expected row count, the expected
   annotator ids — so the corpus stays pinned to a real event rather than becoming unguarded.
   The current test is designed to fail the moment rows appear, so that adding them is a
   deliberate, reviewable act rather than a quiet drift.
