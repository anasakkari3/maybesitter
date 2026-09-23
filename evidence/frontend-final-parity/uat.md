# Authenticated frontend parity UAT — 2026-09-23

The test used the isolated `MS Coral Parity` iOS 26.5 simulator, a signed
development client loading this worktree's Metro bundle on port 8082, the
production Next.js build on port 3001, and isolated Firebase Auth/Firestore
emulators on ports 9261/8261. The account was disposable and local to those
emulators. The mobile client sent real Firebase ID tokens to `/api/mobile/**`;
`mockAdapter` and the dev bearer bypass were not used. No real user content or
provider account was used.

| Flow | Observed result and backend evidence |
|---|---|
| Auth and onboarding | Signed in with the emulator account through the native Firebase SDK. Chose AI processing off, completed routine setup and reached Today. `GET /consents` reflected the declined choice. |
| Capture, Review and persistence | Entered “Call Dana tomorrow at 4 PM”; the rule-based proposal showed a 16:00 deadline; explicitly confirmed it. Today and Calendar showed the saved item. Edited its title in Details; authenticated `GET /commitments/[id]` returned the edit. |
| Commitment lifecycle | Captured and confirmed “Send the test draft tomorrow at 10 AM”. Postponed it to next week; authenticated GET returned `currentAckState: postponed`, the unchanged due time and a separate `postponedUntil`. Today and Details now display both. Completed it, then used a confirmation dialog to drop the other synthetic commitment. Authenticated GET returned `completed` and `dropped` respectively. Reloading the JS bundle preserved the finished state. |
| Daily plan | Built a proposal, accepted it, and observed “Plan saved for today”. Regeneration returned a fresh unaccepted proposal. Activity recorded the accepted plan. The late-afternoon proposal had no schedulable blocks; plan-block editing therefore was not exercised in this local session. |
| Memory, goals and personalization | With the memory feature enabled in the local backend, saved a manual fact and a user-stated goal with AI processing declined. Authenticated `GET /memory` returned both, and both rendered after refetch. Goal execution loaded its checkpoint. Local rules did not propose milestone steps for this goal, so selecting/linking a proposed step was covered by route/UI tests rather than this simulator run. |
| Habits | Created a habit through the coral screen. It appeared immediately; pause and resume updated the visible state. Authenticated POST returned 201 and 12 bounded occurrences for a three-times-weekly definition. Occurrence review remains correctly labeled future-facing because there is no mobile occurrence-list read route. |
| Watchers and background activity | Created a readiness watcher, inspected it in Background Activity, paused/resumed it, and verified its stored projection through authenticated GET. The first creation exposed a 201-vs-200 client contract bug: the server saved the watcher while the app showed an error. Corrected the endpoint and verified a subsequent creation through the UI. |
| Financial context | Added a synthetic USD 42 utility obligation through the coral Financial Context screen. It rendered and authenticated `GET /financial/context` returned the bill. |
| Trust and activity | Trust showed the separate server-backed consent toggles and the new pilot incident form. Authenticated local POST to `/pilot/incidents` returned 201 with only an incident id/status; the client form sends only surface and category. Activity showed the capture and accepted plan events plus first-value moments. |
| Locale and appearance | In the simulator, switched among English, Arabic and Hebrew. Verified Arabic/Hebrew RTL settings labels and controls, then inspected Hebrew dark and Arabic light screenshots. The separate light/dark and large-text suites cover additional rendering states. |

The same 201 contract defect was found in manual memory creation, habit
creation, and keeping a learned suggestion. All four affected mobile clients
now declare the route's 201 status, and endpoint tests parse real route response
fixtures. The pilot incident client also expects 201.

## Certification boundary

- **Simulator verified:** signed development client, real emulator auth,
  backend persistence, capture/review/confirm, edit, postpone/complete/drop,
  plan build/accept/regenerate, memory and goal creation, habit lifecycle,
  readiness watcher lifecycle, financial manual obligation, Trust reachability
  and activity history.
- **Verified by automated contract/UI tests, not this simulator run:**
  clarification, plan block edit and protected-flexible proposals, memory
  suggestion Keep/Dismiss, goal proposal confirmation/unlink, ICS feeds,
  notification action taps, share extension intake, AX5/xxxLarge text and
  account deletion.
- **Physical device or signed native certification still required:** camera,
  microphone speech recognition, HealthKit/Health Connect, device calendar
  permissions and write-back, notification delivery/actions, home-screen
  widgets and OS share extensions.
- **External account or provider setup required:** direct provider OAuth and
  live calendar/health feeds, football feeds, FCM delivery, paid/entitlement
  verification. Unsupported direct integrations remain labeled Coming soon.

The Firebase emulator suite passed 59/59 when run serially. Parallel emulator
execution hit one transaction-lock contention failure on the local machine;
the serial rerun passed. No production account, paid provider or physical
device was used.

Automated verification at handoff: root `npm test` 6208/6208, mobile Jest
210 suites and 2801 tests passed, root and mobile TypeScript passed, root
production build passed, test-registration and no-Flutter guards passed, and
mobile lint had zero errors (71 warnings, chiefly React ref and
array-style rules). Graphify was refreshed after the code changes.
