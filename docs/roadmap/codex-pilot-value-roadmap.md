# Codex Pilot Value Roadmap

Created: 2026-08-19

This roadmap compresses the pilot-facing value work into four parallelizable
sprints. It is intentionally separate from the long-term S07-S11 Core
Intelligence roadmap: S07-S11 build hidden intelligence modules, while this plan
builds the participant experience needed to test whether 25-40 people feel the
main promise in daily use.

Pilot promise under test:

> MaybeSitter helps you capture messy commitments quickly, keeps the most
> important thing visible, and reminds you with the right level of awareness at
> the right time.

This plan keeps the current product strategy's trust boundary: no broad private
message ingestion, no medical/therapeutic claim, no autonomous life-management
claim, no hidden persistence, and no sensitive inference. External sources are
progressive opt-in surfaces, not default ingestion.

## Scope

### In

- Fast spoken prompt input.
- Native iPhone presence through WidgetKit.
- Lock Screen / glanceable next-item surface where feasible.
- Importance-aware notification and awareness escalation.
- Basic Apple Watch presence through notification actions and a simple
  complication.
- Short routine and habit onboarding survey.
- One calendar import MVP.
- Privacy-safe manual import from notes/email through share or paste.
- Pilot analytics, feedback, kill switches, and readiness checks.

### Out For This Roadmap

- Full Gmail mailbox ingestion.
- Full OneNote/Notes continuous sync.
- Fake or non-VoIP phone-call escalation.
- Critical Alert entitlement dependency.
- Broad planning UI.
- Deep personalization before pilot behavior exists.
- Any S07-S11 module becoming user-visible without a separate release gate.

## Sprint Summary

| Sprint | Name | Goal | Issues |
| --- | --- | --- | --- |
| Codex 1 | Native Pilot Foundation | Create the shared native/mobile substrate all parallel work depends on. | C01-C02 |
| Codex 2 | Capture And Phone Presence | Make the first value loop fast and visible without opening the app. | C03-C05 |
| Codex 3 | Awareness And Calendar | Turn importance into timed awareness and bring in one trusted schedule source. | C06-C08 |
| Codex 4 | Watch, Imports, And Pilot Readiness | Extend presence to Watch, add safe source intake, and package the closed pilot. | C09-C10 |

## Issue Backlog

### C01 - [Codex 1][Foundation] Define Pilot Presence Contracts And Shared Storage

**Outcome:** A versioned contract layer for the mobile app, native widgets,
watch surfaces, and notification engine.

**Deliverables**

- `CommitmentSnapshot` contract for widgets, watch, and notifications.
- `ReminderPolicy` contract for soft awareness, follow-up, and strong reminder.
- `UserRoutineProfile` contract for onboarding survey output.
- App Group / shared-storage bridge design for Flutter and iOS extensions.
- Feature flags and kill switches for widget, voice, awareness, watch, and
  imports.

**Acceptance criteria**

- Native extensions can render from the snapshot without reading app internals.
- Snapshots contain titles only when explicitly allowed for the surface.
- No native surface can mutate canonical state directly.
- Tests cover serialization, privacy redaction, and stale snapshot handling.

### C02 - [Codex 1][Product] Build Short Routine And Habit Onboarding Survey

**Outcome:** A low-friction first-run survey that gives the assistant enough
context to avoid obviously bad reminders.

**Deliverables**

- Five-question first-run survey covering sleep, work/study windows, fixed
  commitments, preferred reminder intensity, and quiet hours.
- Editable routine profile in settings.
- Skip path that still lets the product work.
- Localized English, Arabic, and Hebrew copy.

**Acceptance criteria**

- Completion target is under two minutes.
- Skipping does not block capture.
- Profile changes immediately affect future reminder policy decisions.
- Survey stores no diagnosis, medical status, or sensitive labels.

### C03 - [Codex 2][Mobile] Add Fast Spoken Prompt Input

**Outcome:** A participant can capture a messy commitment by voice with one
obvious action.

**Deliverables**

- Primary "speak what is on your mind" capture action.
- Speech permission and failure states.
- Speech-to-text result review before extraction.
- Fallback to typed input.

**Acceptance criteria**

- The user can edit transcribed text before analysis.
- No audio is retained after transcription unless a future consented feature
  explicitly changes that.
- Permission denial leaves typed capture fully usable.
- Widget and app entry points can deep-link to the same capture flow.

### C04 - [Codex 2][iOS] Build iPhone Widget And Lock-Screen Presence

**Outcome:** MaybeSitter is visible where the user already looks: Home Screen
and Lock Screen where supported.

**Deliverables**

- WidgetKit extension using the shared `CommitmentSnapshot`.
- Small/medium Home Screen widgets for next item and top priorities.
- Lock Screen/accessory widget where supported by the target iOS version.
- Deep links to capture, today, and next item.

**Acceptance criteria**

- Widget renders useful empty, loading, stale, and populated states.
- Widget never exposes sensitive details when privacy mode is enabled.
- Widget refresh is deterministic and bounded.
- Simulator screenshots cover light, dark, and RTL-relevant text cases.

### C05 - [Codex 2][Quality] Wire Pilot Loop Analytics For Capture, Widget, And First Value

**Outcome:** The pilot can measure whether the phone-presence loop creates
behavior, not just enthusiasm.

**Deliverables**

- Events for voice capture started/completed/abandoned.
- Events for widget impression, widget tap, and deep-link target.
- First-value event when a participant reaches a useful next commitment or
  reminder.
- Privacy-safe analytics schema update.

**Acceptance criteria**

- No raw spoken text, transcript, note text, or email content enters analytics.
- Events reconcile by pseudonymous participant and feature flag state.
- Reports show activation and first-value denominators.
- Analytics can be disabled without breaking product use.

### C06 - [Codex 3][Notifications] Implement Soft Awareness Reminder Engine

**Outcome:** MaybeSitter can ask for awareness before a commitment without
creating panic or noise.

**Deliverables**

- Native notification permission flow.
- Soft awareness schedule, defaulting to one hour before timed important items.
- Notification actions: Aware, Snooze, Done.
- Quiet-hours and routine-profile guardrails.

**Acceptance criteria**

- Soft awareness is not scheduled during quiet hours unless the user overrides.
- Aware/Snooze/Done actions write through deterministic app commands only.
- Missed or ignored soft awareness is recorded as an event, not as blame.
- Kill switch disables new notifications without deleting commitments.

### C07 - [Codex 3][Policy] Add Importance-Based Escalation Rules

**Outcome:** Reminder intensity follows importance and user consent.

**Deliverables**

- Policy mapping for Nice, Should, and Must commitments.
- Strong reminder path around ten minutes before high-importance timed items.
- User controls for maximum reminder intensity.
- Safe copy for stronger reminders.

**Acceptance criteria**

- Nice items never escalate beyond soft reminder by default.
- Must items can escalate only when the user opted into stronger reminders.
- Escalation never uses fake phone calls or deceptive system UI.
- Every escalation reason is explainable in the trust/control surface.

### C08 - [Codex 3][Calendar] Implement One Calendar Import MVP

**Outcome:** The pilot can test whether real schedule context improves reminder
timing without requesting every external account.

**Deliverables**

- Pick exactly one first provider for the pilot: Apple Calendar via EventKit or
  Google Calendar via OAuth.
- First provider chosen for this pilot: Apple Calendar via EventKit, because
  the current product is iPhone-first and EventKit avoids OAuth account setup
  while keeping the MVP read-only and local to the Flutter/iOS boundary.
- Read-only event import into a bounded availability/schedule context.
- Calendar consent, disconnect, and deletion controls.
- Conflict awareness between imported events and MaybeSitter commitments.

**Acceptance criteria**

- Calendar import is opt-in and can be revoked.
- Imported event details are redacted from analytics.
- The app works without calendar access.
- The roadmap records which provider was chosen first and why.

### C09 - [Codex 4][Watch] Add Apple Watch Basic Presence

**Outcome:** The watch reinforces awareness without requiring a full watch app.

**Deliverables**

- Mirrored notification actions for Aware, Snooze, and Done.
- Simple Watch complication showing next item or no-item state.
- Shared snapshot redaction rules reused from iPhone widgets.
- Watch-specific empty and stale states.

**Acceptance criteria**

- Watch actions reconcile with the same deterministic command path as phone
  actions.
- Complication does not expose private titles when privacy mode is enabled.
- Watch work can be disabled independently from phone notifications.
- Simulator/device verification evidence is attached before pilot release.

### C10 - [Codex 4][Pilot] Add Safe Source Intake And Closed-Pilot Readiness Package

**Outcome:** Participants can bring commitments from notes/email manually, and
the team can ship the 25-40 person pilot with measurable safety and utility.

**Deliverables**

- Share-to-MaybeSitter or paste/import flow for selected text from Notes, Gmail,
  OneNote, or other apps.
- Explicit user review before extraction or saving.
- Pilot readiness checklist covering TestFlight, trust center, support,
  incidents, rollback, and analytics reports.
- Feedback prompts for usefulness, annoyance, and reminder timing.

**Acceptance criteria**

- No background Gmail, OneNote, or Notes sync ships in this issue.
- User-selected imported text is handled like manual capture and is not stored
  without confirmation.
- Pilot report separates widget, voice, notification, calendar, and import
  value signals.
- The closed pilot cannot start unless kill switches, deletion, and support
  paths are verified.

## Parallel Execution Model

Each sprint can run with multiple agents, but every sprint needs one merge owner
who protects the shared contracts.

| Lane | Owns |
| --- | --- |
| Mobile/Flutter | Capture UI, onboarding, settings, trust controls, feedback UI. |
| iOS Native | WidgetKit, notification actions, App Groups, Watch complication. |
| Backend/Policy | Reminder policy, snapshot builder, command routing, analytics. |
| Quality/Ops | Tests, simulator/device verification, privacy review, pilot package. |

## Recommended Pilot Cut

The minimum credible 25-40 person build is C01-C08 plus the pilot-readiness
parts of C10. C09 Apple Watch is high-value if the target cohort uses watches,
but it should not block the first closed pilot if iPhone widget and native
notifications are working.

Gmail, OneNote, and broad notes access should start as user-selected
share/paste intake in C10. Continuous account sync should be a later roadmap
only after the pilot proves trust and repeated value.
