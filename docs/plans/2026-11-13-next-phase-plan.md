# Next-phase plan, after the QA verification (2026-11-13)

This plan follows the verification of the 247 audit findings on `de7fcb84`. The work stops when this plan is written; nothing below starts until the owner says so.

## Where things stand

- **Production:** the owner dispatched `deploy.yml` for `de7fcb84` (run 43426392295). At writing it is **waiting for the environment approval** in GitHub. Production still serves `ee82d01` (`maybesitter-api-00014-nuf`).
- **Staging:** serves `de7fcb84` as `maybesitter-api-staging-00678-xin`.
- **The verification.** Each of the 247 findings got exactly one verdict, and nothing was fixed:

  | Verdict | Count |
  |---|---|
  | Confirmed on the simulator | 91 |
  | Confirmed against the staging API | 40 |
  | Not reproduced | 12 |
  | Cannot observe in this setup | 104 |

  Verifying also turned up 34 new findings: 5 S2, 10 S3 and 19 S4. The evidence is outside the repo, in `evidence/qa-audit-de7fcb8/VERIFY-REPORT.md` (Arabic summary in `VERIFY-REPORT-AR.md`).
- **Open PRs held unmerged:** #839 (plans), #840 (Gmail sender filter, flag off) and #841 (ended events, lane E1).
- **QA accounts:** only `qa-audit-de7fcb8-v5` and `-v7` remain; both have dense test data. The rest were deleted, including v32, whose trust had been revoked, by admin.

## Owner decisions of 2026-11-13

1. **Production deploy:** dispatched by the owner, waiting for approval.
2. **Event or task:** the model classifies at capture, with a 10–20¢ eval first. This is approved and written into the spec's lane E1.
3. **Lane E4:** missed work gets a real, workable rescheduling proposal. The full rule is in the spec.
4. **QA accounts:** keep what is needed and delete the rest. Done.
5. **A Google test account:** explained to the owner; it waits on them. See "Tooling".
6. **Neither a fix run nor QA v2 now.** Write this plan and stop.

## Order of work

Each wave starts only after the previous one is merged and on staging. The release-readiness plan's tracks and the one-month product plan (P1–P9) resume after Wave B.

### Gate 0: production on `de7fcb84`

- The owner approves run 43426392295.
- `/api/health` on production must report `de7fcb84`.
- Then merge #839, then #841 with the E1 classification, then #840. Each merge is followed by a manual staging deploy.

### Wave A: the 12 confirmed S1 findings, plus what spends money with no limit

| Lane | Findings | Expected result |
|---|---|---|
| A1 Account isolation | C13.14/CXA13.1, C12.1, CA1.8 | Sign-out and deletion cancel every local notification and clear the notification routing. A revoked account can still export and delete. The app's minimum password length matches Firebase's, or the app shows a reset path. |
| A2 Paid calls | CXA2.9, CA4.7/CXA4.2, CXA7.3, CXA7.2, C12.2/CXA12.1, NX4.1 | Meeting prep is idempotent per request key. A day that has passed cannot be regenerated, accepted or dismissed. The answer route honours recommendation consent. A malformed `generate` request gets a 400 before any model call. A feature switched off stops its paid paths. An empty plan build makes no model call. |
| A3 Lost input | CA3.6/CXA3.3, CA8.2/CXA8.2, CA2.2, NA2.1, CX3.5/CXX3.1 | Text over 2,000 characters is refused with a message, and the server caps it too (see #508). A failed save keeps the typed text. The edit sheet never carries another card's title or a stale title. An action taken offline is either saved durably or refused with a message, and is never sent after the person has left the flow. |
| A4 Owner decision | C13.10 | The owner chooses whether a place reminder may show the real title on the lock screen. If not, it is hidden the way the widget hides it. |

### Wave B: the confirmed S2 findings and the new S2s

| Lane | Findings |
|---|---|
| B1 Today and next step | OWN-1 (lane E1, already built in #841), CA2.1, CA2.3/CXA2.3 |
| B2 Plan | CA4.1, CA4.4/CA10.3/CXA10.1, including the free-time view that counts a full day as free |
| B3 Capture extraction | CA3.1, NAPI-A8.1/NA3.4, NAPI-A8.2, NA3.2, NA3.3, NA2.3. Build a labelled eval set first (lists, timed lists, shares, injection lines, relative days), measure, fix, then measure again. The eval spend needs an owner yes with an exact figure. |
| B4 Habits | CA5.4/CXA5.4: mark an occurrence done or "not today" |
| B5 Watchers | CA6.1 (a firing must reach the phone), CXA6.1 (a watcher re-arms after a change) |
| B6 Goals | CA7.1, CXA7.1 (a new goal shows its proposed steps) |
| B7 Memory | CXA8.4 |
| B8 Calendar | CA10.1, CA10.4/CXA10.3 (consent, quota and removal for manual busy time), CA10.5 with NAPI-A10.1 (disconnect really stops use) |
| B9 Football | CXA11.3, CA11.1 (partly covered by E1) |
| B10 Notifications | NA13.1. Check it on a release build first; fix only if it reproduces there. |

### Wave C: things whose time has passed (the owner's design)

E2 builds the «ما اتصرّفت فيها» place, E3 the gentle question after capture, and E4 real rescheduling of missed work. The spec is `2026-11-12-spec-expired-commitments-and-gmail-sender-filter.md`.

### Wave D: tooling for the 104 that could not be observed

Each tool is listed with the findings it opens, in order of yield.

1. **A Google test account (22 findings, plus Gmail filter testing).** This is a new, free Gmail address that is not the owner's.
   - The owner creates it.
   - If the OAuth app `maybesitter-app` is in Testing, the owner adds it as a test user under Google Auth Platform → Audience.
   - The account is sent about 20 mails from another address: real requests with dates, newsletters and promotions, and one unimportant subject repeated 6 times.
   - The owner signs it in on the simulator. Its password is never given to an agent.
   - Read access to staging Firestore for the deletion races adds 3 more findings.
2. **A proxy on the simulator (24 findings).** Proxyman or Charles rules that fail, delay or hold one route. Alternatively, a dev build with a fault-injecting fetch.
3. **A private staging revision (27 findings).** It has its own flag set: GOAL_PLAN on, add-on gate set to `enforce`, MEMORY off, ICS off, plus server fault injection. Revision 00678 is never touched.
4. **One Android phone and one real iPhone (14 findings).** These need FCM push, VoiceOver and Sign in with Apple. Hardware or store accounts wait for the funding, as before.
5. **Time and scale (9 findings).** One session across local midnight, an ICS file we control, and a dataset with more than 200 watchers.
6. **CA11.4:** one `axe describe-ui` read on the simulator.

The same verification brief is then re-run on these rows only.

### Wave E: confirmed S3 and S4 findings

There are 75 S3 and 27 S4 findings, grouped by unit. Each batch is one lane with one reviewer.

### After that

- **QA v2:** the 3,500 external cases. The owner approves $5–10 before it runs.
- **The product plan P1–P9:** in the first month, inside the time left before 2026-12-11.

## Rules for every fix lane

- **Fail first.** The first commit is a test that fails on `de7fcb84`'s behaviour. A mutation check then proves the test reaches the exact line that was fixed.
- **Split building and review.** One agent builds and another reviews; Codex and Claude alternate. A builder never reviews their own work.
- **Skills by surface,** following AGENTS.md: React Native screens get `design-design-system` and `design-accessibility-review`, copy gets `design-ux-copy`, and backend lanes usually need none.
- **Prove it on the device.** Deploy to staging manually, then re-run the finding's original steps on the simulator. The verdict is recorded as FIXED in `evidence/qa-audit-de7fcb8/FIX-TRACKER.md`, with the commit, the staging revision and a screenshot.
- **Limits:**
  - at most 3 agents, with only one of them on the simulator;
  - every emulator, simulator and Metro stopped when a lane ends;
  - no production deploy, and no merge to main, without the owner's go;
  - no spending without the exact figure and the owner's yes.

## Costs

| Item | Cost | Status |
|---|---|---|
| E1 classification eval | about $0.10–0.20 | approved |
| Capture extraction eval (B3) | to be estimated before it runs | needs a yes |
| Re-verification on the simulator | under $0.50, about what the first pass cost | within the earlier $2 |
| QA v2 | $5–10 | not approved |
| A proxy app, an Android phone, an iPhone | outside this plan | waits for funding |
