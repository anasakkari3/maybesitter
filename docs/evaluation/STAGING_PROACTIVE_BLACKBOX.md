# Proactive intelligence staging blackbox — 2026-09-30

## Build under test

- Backend: Cloud Run `maybesitter-api-staging`, revision `maybesitter-api-staging-00643-boy`, 100% staging traffic, ready endpoint healthy. It contains backend commit `857dd4a2`.
- Mobile: Android staging APK built locally from commit `36d9ff0c`, package `com.maybesitter.app`, installed on isolated Android emulator `emulator-5556`. Embedded `appEnv=staging`, `apiMode=api`, and the staging API URL were inspected from the APK.
- Gmail monitor: staging Cloud Scheduler job `intelligence-gmail-staging` enabled and a manual invocation returned HTTP 200.

## API blackbox

Run `STAGING_CANDIDATE_URL=https://maybesitter-api-staging-xw5vhndxxq-ew.a.run.app node scripts/blackbox-staging-api.mjs` from the monorepo. The probe creates a disposable Firebase user and deletes the account in `finally`.

Latest result: semantic observations created; seven linked ideas produced, including event preparation; three schedule previews returned, two placed; accepting a displayed slot wrote the identical start and end to the confirmed commitment; retry did not duplicate it; after personalization consent and completion, a behavioral outcome was available to the next decision; account deletion succeeded. The probe returned exit code 0.

The full server test suite passed on the final branch: 8,199 tests, 0 failures. Mobile TypeScript checking passed, Expo Doctor passed all 21 checks, the native configuration test passed 46 tests, and the Android release APK built and installed successfully.

## Installed Android blackbox

Fresh install sign-in gate passed `.maestro/auth-gate.yaml`. A disposable email/password user signed in, completed onboarding with recommendations enabled, and navigated to **سياق يومك → خطوات الهدف**. The installed build loaded the staging intelligence panel.

The account entered: `عندي امتحان رياضيات بكرا الساعة 9 الصبح، ولسه ما درست منيح. عندي سهرة مع الصحاب الليلة من الساعة 10 للساعة 1.` The UI stored three source observations (exam, party, readiness constraint), then displayed a party/ready-for-exam warning, a preparation goal, one review action, and a question about changing the party time. The goal and action were explicitly accepted in the app; the action appeared in `/api/mobile/commitments/today`. After the action was completed and personalization was enabled, the next generation stored `Completed: مراجعة سريعة لمفاهيم الرياضيات الأساسية` as behavioral evidence. The disposable account was deleted using the account deletion API after fresh sign-in.

The review action had no feasible slot in this live session because the test ran at about 22:10 local time, the action needed 60 minutes, and the planner would not put exam preparation after the exam. The API blackbox separately verified a feasible displayed slot was pinned on acceptance. The UI showed that it had no available slot rather than inventing one.

## Scope limits

- Background semantic monitoring currently covers Gmail after explicit opt-in; connected Calendar offers free/busy only, and Drive analysis is limited to user-selected files. Wider access needs separate scopes, reconnection, and source-specific tests.
- External email can supply an outcome hint for review. It is not treated as proof that an obligation was completed.
- The model consumes observation confidence, memory, prior decisions, and behavioral outcomes, but no calibrated per-person probability model has been validated. Model-reported confidence must not be read as a measured prediction.
- This is staging evidence. The Stage B release gate remains locked pending market evidence; no production rollout is implied.
