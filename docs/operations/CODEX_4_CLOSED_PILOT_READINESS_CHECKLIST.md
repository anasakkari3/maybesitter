# Codex 4 Closed Pilot Readiness Checklist

Sprint: `Codex 4`
Roadmap scope: `C10`
Last updated: `2026-08-20`

This checklist is the operational gate for the first 25-40 person closed pilot
candidate that includes safe source intake.

## Release gate

Closed pilot remains blocked until every item below is marked complete with
named evidence.

- [ ] TestFlight or direct device distribution path verified for the candidate build.
- [ ] Trust Center path verified from the shipping app.
- [ ] Participant support path verified and documented for pilot operators.
- [ ] Incident owner named and incident path verified against `docs/operations/V03_PILOT_OPERATIONAL_DEPLOYMENT.md`.
- [ ] Rollback path verified against `docs/operations/V03_PILOT_OPERATIONAL_DEPLOYMENT.md`.
- [x] Kill switches verified for widget, voice, awareness, watch, and imports. Evidence: `mobile/test/unit/kill_switches_test.dart` — each switch silences its own surface and only its own; killing the widget leaves reminders scheduled, killing awareness cancels reminders already handed to the platform without deleting the commitment, and killing the watch clears the wrist rather than leaving stale state on it.
- [x] Participant deletion path verified end to end. Evidence: `mobile/test/unit/deletion_end_to_end_test.dart` drives `DeletePilotData` through the trust controller; `mobile/test/unit/participant_erasure_test.dart` covers the erasure itself. Deleting now reaches the imported calendar, the snapshot the widget and watch read, the acknowledgement record, and reminders already pending with iOS, continues past any store that fails, and runs before the credential is dropped. Previously this deleted only the credential token.
- [ ] Feedback history/privacy surfaces verified from the app.
- [ ] Import intake confirmed to be manual only: no background Gmail, OneNote, or Notes sync.
- [x] Import review confirmed: selected text is reviewed before extraction or saving. Evidence: `mobile/test/widget/codex4_pilot_features_test.dart` — 'clipboard import requires review before populating composer'. Pasted text lands in the composer for the participant to read and confirm; nothing is extracted or persisted before that.
- [ ] Pilot signal report template prepared for widget, voice, notification, calendar, and import.

## Evidence to attach

- Candidate mobile SHA and branch name.
- `flutter test` result for the Codex 4 slice.
- iOS simulator build result for the candidate SHA.
- Watch complication simulator verification note.
- Screenshot set for import review flow and pilot feedback prompt.

## Scope protection

Codex 4 intake is intentionally narrow:

- Allowed: user-selected clipboard/share text that the participant explicitly reviews.
- Not allowed: continuous mailbox sync, continuous notes sync, or silent background import.

If any blocked item above regresses, the pilot gate returns to `HOLD`.
