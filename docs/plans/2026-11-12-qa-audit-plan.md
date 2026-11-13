# QA audit plan: code first, then the simulator, then a comparison report

> **Superseded on 2026-11-12 by `2026-11-12-qa-audit-plan-v2.md`.** v1 read expected behaviour from the code and so could not catch behaviour that is wrong by design.

Date: 2026-11-12. Audited commit: `main` = **`de7fcb84`**, served by legacy staging revision `maybesitter-api-staging-00676-qew`.

Inventories:
- `docs/plans/inventory/mobile-surfaces.md`
- `docs/plans/inventory/backend-capabilities.md`

Staffing: `docs/plans/2026-11-12-agent-team.md`.

## What this is, and what it is not

The owner's order (2026-11-12): every feature and every interface is first tested **in the code**, then run **literally on the simulator**. The two are then **compared**, and the result is a **clear report**.

- **This is an audit, not a fix plan.** Nobody changes product code, opens a fix PR, or deploys during the audit. A finding is written down, never fixed.
- What is fixed, and when, is decided by the owner after reading the report.

## Rules for the whole audit

1. **One commit.** Every result is for `de7fcb84`.
   - Each stage starts by reading `/api/health` on staging and the app build's commit, and records both.
   - If staging or the build changes mid-audit, the results of the affected areas are void and those areas are redone.
   - A PASS never carries over to another commit (`evidence/UAT-EVIDENCE-INDEX.md`).
2. **Real backend, real model.** The simulator app talks to staging, which uses the Firestore `staging` database and real Gemini.
   - No `API_MODE=mock` and no in-memory storage.
   - Both fake defects in the past: see the memory notes "RC UAT testbed hazards" and "Jest hides device-only gaps".
3. **Test accounts only.** Staging shares Firebase Auth with production.
   - The audit uses a fixed set of QA accounts. The owner approves them once; they are listed in the report and deleted at the end through the in-app deletion (which is itself a test).
   - The dense account is seeded with many commitments, so that screens are tested under load and not empty.
4. **Money.** Model calls on staging cost real money. The estimate for the whole audit is **under $2** (capture, chat, plan, profile and intelligence calls).
   - The audit does not start until the owner says yes to that ceiling.
   - The report states the actual Vertex spend.
   - No paid eval script runs inside this audit.
5. **Machine rules.** At most one iOS simulator and at most one Android device or emulator on the machine. Check memory before booting. Shut everything down at the end and prove it in the report: `xcrun simctl list devices booted`, `pgrep -fl qemu-system` and a port check.
6. **Drive the simulator by accessibility ID** (`AXUniqueId` through `axe`), never by point taps.
   - Enter Arabic text by paste.
   - The build must be built with `xcodebuild`.
   - Check that the app on screen is ours (bundle ID and Metro port), because other agents share the machine.

---

## Units of audit

Each unit goes through the three stages below.

| Unit | Scope (see the inventories) |
|---|---|
| A1 | Language gate, sign-in (email, Google), email verify, onboarding (consent, routine, setup chat, AI import, notifications step) |
| A2 | Today, next-step card, details, the postpone/edit/drop/delete sheets, meeting prep |
| A3 | Capture «احكيها»: chat, review, clarify, confirm, saved, undo, clipboard; voice; share intent → share screen → review |
| A4 | «الخطة» tab, today's plan (build, accept, regenerate, edit), week plan, patch review, free time |
| A5 | My things, commitments list, search (m6), habits, seeds |
| A6 | Watching, background activity, watch builder, held items |
| A7 | Goals screen, goal graph, goal-plan flow (routes answer 404 today, so check that it is hidden), IntelligencePanel |
| A8 | Knows, memory screen, memory summary and translation, personalization, AI import |
| A9 | Google integration: connect, reconnect, disconnect; Gmail scan and monitor; «انضاف من إيميلك»; Drive import |
| A10 | Calendar settings, device calendar read and write, ICS links, weekly blocks, M5a calendar choice |
| A11 | Football settings, sources hub, fixtures |
| A12 | Settings hub and all five categories, «الميزات», notifications settings, trust, activity, feedback history, export, sign-out, account deletion |
| A13 | Native: widget, local notifications and hard reminders, notification taps, deep links, places, health card |
| X1 | Language and direction: Arabic RTL in full; English LTR on each unit's main flow; Hebrew is recorded as present or absent, not judged |
| X2 | Accessibility: AX5 text size on every main screen, VoiceOver labels on primary actions, reduce motion |
| X3 | States: empty, loading, offline, server error, quota (429 scopes), feature unavailable (404), permission denied |
| X4 | Backend black box, no UI: auth required on every `/api/mobile/**` route; account A cannot read or change B's data; AI consent gates every model route; internal routes refuse a caller without the Scheduler token; caps answer 429 |

---

## Stage 1: code audit (no device)

For each unit, produce `evidence/qa-audit-de7fcb8/<unit>/1-code.md` with three parts.

**1a. Expected-behaviour sheet.** A numbered list of what the code says the user can do and see. Each entry, `E<unit>.<n>`, has:
- trigger: the screen and the exact testID or gesture;
- what the code says happens: UI change, endpoint and method, server effect, and the copy key shown;
- each state the code handles for it: empty, error, offline, quota, 404, permission;
- the gates that decide it, with their value **on staging** for this commit;
- the source, as `file:line` in `mobile/src/**` and `src/app/api/**` / `lib/**`.

The sheet must cover every action and state listed for the unit in the inventories. A row the code does not support is written down as such.

**1b. Test run.** Run the existing tests for the unit and record the result:
- mobile Jest for the unit's folders with `--maxWorkers=4`;
- the backend test files for its routes and services (helper: `run-subset.sh '<regex>'`).

Also record:
- behaviours from 1a that no test covers;
- tests that look vacuous: they pass whatever the code does, or are pinned to a date;
- Maestro flows that no longer match the code. Two are known: `feedback-history.yaml` and `delete-account.yaml`.

**1c. Code findings.** Defects visible from reading the code, `C<unit>.<n>`. Each has:
- `file:line`;
- what goes wrong, and for which input;
- why the reviewer believes it;
- confidence (high / medium / low).

Known open issues in the unit (for example #739, #741, #752, #802, #807 and #815) are listed and marked **"verify on device"**. They are not taken as true.

No code is changed. A finding that needs a test to prove it may use a scratch test **outside** the repository; it is never committed.

## Stage 2: simulator run (literal)

For each unit, produce `evidence/qa-audit-de7fcb8/<unit>/2-device.md` plus the screenshots.

- **Build:** a development build of `de7fcb84`, built with `xcodebuild` and pointed at the staging URL. Record the build's commit, the simulator model and the iOS version.
- **Run:** every `E<unit>.<n>` from Stage 1, literally, in Arabic first. For each, record:
  - the steps taken (the accessibility IDs tapped and the text pasted);
  - what was seen: a screenshot, and an excerpt of the accessibility tree where text matters;
  - the network effect where it can be seen, by reading the result back through the API or by re-opening the screen;
  - the time it took, when it was slow (more than 3 seconds to a visible answer).
- **Matrix:**
  - each unit's main flow again in English;
  - Today, Capture, Plan, Details, Settings and «الميزات» at AX5 text size;
  - one pass in dark mode;
  - offline: Network Link Conditioner or airplane mode on the host, for the states that claim offline handling.
- **Cannot run on the simulator:** real push delivery, hard-ring sound, voice dictation quality, health data and exact alarms. These are marked `NOT-RUN (simulator)` with the reason. They go to an Android-device pass on the owner's Redmi, run after the iOS pass on the same commit, or are left listed as not verified.
- **Do not fix or retry around a failure.** Record it, note whether it repeats over 3 tries, and move on.

## Stage 3: comparison and report

For each unit, produce `evidence/qa-audit-de7fcb8/<unit>/3-compare.md`.

- Every `E` row gets one verdict:

  | Verdict | Meaning |
  |---|---|
  | **MATCH** | the device did what the code says |
  | **MISMATCH** | the device did something else; describe both |
  | **MISSING** | the code supports it but the UI never offers it |
  | **NOT-RUN** | with the reason |
  | **BLOCKED** | by a gate, an account or the environment |

- Every `C` row gets one verdict: **CONFIRMED on device**, **NOT OBSERVED**, or **CANNOT BE OBSERVED on device** (why).
- Every known issue gets one verdict: **STILL PRESENT**, **NOT REPRODUCED** or **NOT RUN**.
- Each MISMATCH and each CONFIRMED finding gets:
  - a kind: logic, UI/layout, copy, data, performance, accessibility, environment;
  - a severity:
    - **S1**: data loss, a privacy or account leak, money spent wrongly, or a crash;
    - **S2**: a main flow broken or wrong;
    - **S3**: wrong but with a workaround;
    - **S4**: cosmetic.
- Nothing is fixed or filed as an issue unless the owner asks.

### The final report

Path: `evidence/qa-audit-de7fcb8/REPORT.md`, plus an Arabic summary for the owner.

1. **Header:** the commit, the staging revision, the build, the simulator, the dates, the accounts used, and the actual model spend.
2. **One table per unit:** counts of MATCH, MISMATCH, MISSING, NOT-RUN and BLOCKED; S1–S4 counts; the unit's verdict.
3. **All S1 and S2 findings first,** each with the expected-versus-observed pair, the evidence links and the `file:line`.
4. **Where code and tests disagree with the device.** Green tests that the device contradicts get their own section, because they show where the test suite cannot be trusted.
5. **Coverage holes:** behaviours with no test, and areas that could not be run on the simulator.
6. **What the report does not say:** anything not run is listed. Nothing outside it is claimed to work.

---

## Order of work

1. **Stage 1 for all units in parallel.** These are code-reading agents: no device and light on memory. X4 runs here too, against the staging API with the QA accounts.
2. **Stage 2, one unit at a time** on the single simulator, in this order: A1 → A2 → A3 → A4 → A12 → A5 → A7 → A8 → A6 → A10 → A9 → A11 → A13. The core loop comes first, and Google-dependent units come late because they need the QA Google account connected.
3. **Stage 3 for a unit** as soon as its Stage 2 is done. A different agent from the one that ran Stage 1 does the comparison.
4. **Consolidated report and Arabic summary.**
5. **Close-out:**
   - delete the QA accounts through the app;
   - shut down the simulator and Metro, and prove they are off.

## What the owner provides before Stage 2

- A yes to the spend ceiling (under $2 of Gemini on staging).
- A yes to creating the QA test accounts on the shared Firebase Auth.
- For A9:
  - a Google test account that can be connected;
  - the Gmail scope on an app in Testing mode needs that account added as a test user.
