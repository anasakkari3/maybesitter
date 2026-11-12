# Agent team for the two plans

Date: 2026-11-12. The plans:
- `docs/plans/2026-11-12-qa-audit-plan.md`: the audit. It produces a report and changes no code.
- `docs/plans/2026-11-12-development-plan.md`: the build work.

**The audit runs first.** Development lanes that touch product code wait until the owner has read the audit report, apart from lanes the owner releases earlier.

## Ground rules for every agent

- **At most 3 agents run at once on this machine,** builders and reviewers combined. Eight at once exhausted the session limit twice. Queue the rest.
- **One iOS simulator and one Android device or emulator, machine-wide.** Each is owned by exactly one agent at a time, the "device seat" below. Shut it down at the end of every job and prove it is off.
- **Each agent works in its own worktree** under `code/<lane-id>`. Its scratch files go under `scratchpad/<lane-id>/`, never at the scratchpad root.
- **No agent may:**
  - deploy staging or production;
  - change a Cloud Run flag;
  - merge to `main`;
  - spend money beyond the ceiling the owner approved.
- **The orchestrator routes skills** (repository `AGENTS.md`). Each brief names the skills that apply; no agent is assumed to remember one.
- **Every claim about repository state is checked before it is reported** (memory note: a "clean tree" claim once hid a deleted safety bound). This applies to "clean", "green" and "pushed".
- **Commit or save evidence after every completed step.** A session limit kills every background agent at once.

## Models and where they fit

| Agent | Model | Use it for |
|---|---|---|
| Orchestrator | this Claude session | routing, briefs, reading every result, the final report, owner communication; keeps one building or reviewing share of its own |
| Claude subagents | Opus | code audit per unit, device runs, building lanes |
| Codex | `gpt-5.6-sol`, effort high (never `gpt-6-sol`) | independent code audit of the same unit (second opinion), building lanes, reviewing Claude-built lanes |
| agy | `claude-opus-4-6-thinking`, own worktree only | short neutral checks: tie-breaks between two audits, mutation and repro checks. Its quota runs out after about 5 minutes of heavy use, so keep its jobs short |
| OmniRoute | routed cheap models | only cheap, verifiable side work, such as checking report formatting or counting rows. Never code judgement, never private data |

**Build and review split** (owner rule): whoever builds does not review their own work. Claude builds and Codex reviews, or Codex builds and Claude reviews. The orchestrator reviews Codex's work itself rather than handing that review to a subagent.

---

## Team 1: QA audit (runs now)

**Seats**
- **Code auditors (Stage 1):**
  - two per unit, one Claude and one Codex, working independently;
  - no device;
  - 2–3 of them can run at once;
  - each writes `1-code.md` for its unit;
  - the orchestrator merges the two sheets, and every disagreement between them becomes a row to check on the device.
- **API black-box auditor (unit X4):**
  - one Claude subagent;
  - works against the staging API with the QA accounts;
  - no device.
- **iOS device seat (Stage 2):**
  - exactly one Claude subagent at a time;
  - owns the simulator and Metro for the whole run;
  - runs units in the order the audit plan gives;
  - writes `2-device.md` and screenshots.
- **Android device seat (optional, after iOS):**
  - one agent;
  - runs only the `NOT-RUN (simulator)` rows on the owner's Redmi;
  - needs the owner to connect the device.
- **Comparator (Stage 3):**
  - an agent that did not audit that unit's code;
  - writes `3-compare.md`;
  - agy breaks ties when the comparator and an auditor disagree about a verdict.
- **Report editor:** the orchestrator writes `REPORT.md` and the Arabic summary.

**Skills per seat**
- Code auditors and the comparator: none. This is an audit, not UI or copy work; findings about copy or accessibility are recorded, not redesigned.
- Device seat: none. It records; it does not judge design.
- Report editor: none.

**Waves, at 3 concurrent agents**

| Wave | Runs | In parallel |
|---|---|---|
| 1 | Stage 1 for A1–A4, then A5–A8, then A9–A13 and X1–X3, two auditors per unit | 3 agents |
| 2 | X4 black box, while the device seat starts A1 | 2–3 agents |
| 3 | The device seat goes through the units one by one; each unit's comparator starts when that unit's device run ends | 2–3 agents |
| 4 | Consolidated report; QA accounts deleted; devices shut down and verified off | 1 agent |

## Team 2: development (after the report, or when the owner releases a lane)

Each lane is one branch and one pull request. It has a builder and a reviewer from the other model. The orchestrator merges only with the owner's permission.

| Lane | Plan items | Builder | Reviewer | Skills |
|---|---|---|---|---|
| L1 Release plumbing | D1.1 promotion runbook, D1.4 EAS profiles, D1.6 stale issues | Claude | Codex | none (CI: `github-actions-sparen` if a workflow changes) |
| L2 Android beta | D1.2 Firebase App Distribution | Codex | Claude | none |
| L3 Apple sign-in ready | D1.3 | Claude | Codex | `design-design-system`, `design-accessibility-review`, `design-ux-copy` |
| L4 Purchases | D2.1 SDK, D2.2 webhook, D2.3 paywall | Codex (D2.2), Claude (D2.1, D2.3) | the other one | backend: none; paywall: `design-design-system`, `design-accessibility-review`, `design-ux-copy`, then `design-design-critique` before merge |
| L5 Gmail add-on | D3.1 (#815, #778), D3.2 OAuth client per environment, D2.4 `user_monthly` status | Claude | Codex | backend: none; status copy: `design-ux-copy` |
| L6 Feature releases | D4, one module per PR, each after its audit unit passes | Codex | Claude | as for each module's UI |
| L7 Core gaps | D5.1–D5.4, plus the S1/S2 findings the owner chooses from the report | Claude | Codex | React Native screens: `design-design-system` + `design-accessibility-review` (+ `design-ux-copy`), and `design-design-critique` before merge |
| L8 Listing kit | D1.5 | Claude | owner | `design-ux-copy` |

A lane is done when all of these hold:
1. its tests fail on the old code and pass on the new (a mutation on the exact defect line);
2. CI is green;
3. the reviewer approved with non-empty coverage;
4. the change was re-run on the device seat against a staging build of that commit.

The owner promotes to production.

## What the orchestrator owns

- Launching the next piece when one ends (the owner's "continuous pipeline" rule).
- Keeping the 3-agent cap.
- Holding the device seats.
- Recording which agent did what in the report's header.
- Stopping and asking the owner only for:
  - money;
  - deploys;
  - merges to `main`;
  - store or console actions;
  - a fork with no safe default. When the owner is away, such forks go to the LLM council.
