# QA private staging revision

Script: `infra/cloudrun/private-staging-revision.sh` (tests: `tests/infra/privateStagingRevision.test.ts`, dry run only).

Some QA rows can only be seen when the server runs with different settings: MEMORY off, GOAL_PLAN on, `MAYBESITTER_ADDON_GATE_MODE=enforce`, or the email sources off. Staging is shared, so its flags must not change. A **private revision** solves this. It is a new revision of `maybesitter-api-staging` with:

- the **image staging serves now**, taken by digest from the revision that holds 100 % of the traffic;
- the **service template's current settings** (read with `gcloud run services describe`), then your overrides. Only the env changes; identity, resources, secrets and probes stay as the template has them;
- a `qa-<name>` tag and **`--no-traffic`**. Only requests sent to the tag URL reach it.

Running it for real deploys to Cloud Run, so it needs the owner's go, like any staging deploy. `--dry-run` and `--list` only read.

## Use

```bash
# 1. Look first: prints the deploy commands and runs only the two describes.
infra/cloudrun/private-staging-revision.sh --name memoff \
  --set MAYBESITTER_FEATURE_MEMORY=false --dry-run

# 2. Create it (owner's go). The last line is the tag URL.
infra/cloudrun/private-staging-revision.sh --name memoff \
  --set MAYBESITTER_FEATURE_MEMORY=false

# 3. See which ones exist.
infra/cloudrun/private-staging-revision.sh --list

# 4. Remove the tag when the check is done. Traffic is not touched.
infra/cloudrun/private-staging-revision.sh --remove qa-memoff
```

Point the API or the app at the tag URL. For curl, use `https://qa-<name>---…a.run.app/api/mobile/...`. For a dev build, set `EXPO_PUBLIC_API_BASE_URL=<tag URL>` and restart Metro. The tag URL uses the same Firebase project, so a staging ID token works there.

**What the script refuses.**
- Any service other than `maybesitter-api-staging`, which rules out production.
- Overriding `MAYBESITTER_ENV`, `MAYBESITTER_FIRESTORE_DATABASE_ID`, `MAYBESITTER_STORAGE_BACKEND`, the project ids, the KMS key, the scheduler audience or account, the deployer account, or the deletion pepper.
- A serving revision that is not `MAYBESITTER_ENV=staging` on the `staging` database.
- An image with no digest.
- Traffic that follows the latest revision (`latestRevision: true`), because a deploy would move it. Pin it first with `update-traffic --to-revisions=<revision>=100`.
- Pinned traffic that does not add up to 100 %, or a split where no single revision holds 100 %.
- A template env value containing `;` or whitespace, which the `^;^` env list cannot carry.
- A tag that already exists.
- `--remove` on anything but an existing `qa-*` tag with 0 % traffic.

**What it changes besides the tag.** A deploy rewrites the service template, and the next CI deploy or `infra/scheduler.sh` run starts from the template. So right after the private revision, the script deploys a second revision with `--no-traffic` and no tag. This **restore** carries the template's original image and env exactly as they were read before the first deploy. `--remove-env-vars` drops any key that your overrides added (for example `MAYBESITTER_FEATURE_GOAL_PLAN`). Secret-backed variables are never copied or changed. `--allow-unauthenticated` is never passed, so the IAM policy is not touched. Every gcloud command carries an explicit `--region`.

**The template, not flags.sh.** The QA revision and the restore both start from the live template, not from `flags.sh staging`. If the two differ (say, a deploy is pending, or someone set a value by hand), the script prints one `warning:` line per difference and still uses the template. Read those warnings: they mean the next CI deploy will change staging anyway.

**If something fails between the two deploys.** After the first deploy succeeds, an `ERR`, `INT` or `TERM` trap is armed. If the restore fails, or the run is interrupted, the restore is tried once more:
- **exit 4:** the template is restored. The `qa-` tag may exist; check with `--list`.
- **exit 3:** the restore failed again. The template still carries the QA overrides, and the ready restore command is printed on stderr. Run it before any other deploy.

If the first deploy itself fails, the template was not changed and the script stops.

### What the private revision shares with staging (read before testing)

- **The data.** It uses the same Firestore database (`staging`), the same Auth users and the same secrets. Anything written through the tag URL is real staging data. Use QA test accounts only.
- **The scheduled jobs.** It shares them, but they never run there. `infra/scheduler.sh` targets the service URL (`status.url`, checked by `--check`), never a tag URL. Every job (the watcher sweep, the Gmail monitor, reminders, daily plan, replan) keeps running on the **serving** revision with the plain staging flags. So a finding that lives in a job cannot be seen by pointing the app at the tag. It needs the operator steps below.
- **The internal routes.** The revision inherits `MAYBESITTER_INTERNAL_AUDIENCE` = the staging service URL. An internal job called on the tag URL therefore needs an OIDC token for the scheduler account, with the **service URL** as audience.
- **The model budget.** Model calls count against the same per-user and global caps (`MAYBESITTER_LLM_*`), and in `maybesitter-app` they cost real Vertex money.
- **The idle cost.** It costs nothing while idle (`--min-instances=0`). Remove the tag when you are done, and delete the revision with the command `--remove` prints if you do not need it again.

## The 14 rows

Source: `evidence/qa-audit-de7fcb8/VERIFY-REPORT.md`, "Cannot observe here", group "Staging flag, build variant or operator action". CA6.6 and CXA11.5 are one finding, so the group has 14 rows and 15 ids.

| # | Id (severity) | Finding | What exposes it | Where |
|---|---|---|---|---|
| 1 | CXA1.3 (S2) | Onboarding treats MEMORY's 404 `feature_unavailable` on describe-confirm as saved and advances | `MAYBESITTER_FEATURE_MEMORY=false` on confirm only | Private revision (+ proxy for the device half) |
| 2 | CA7.2 (S2) | «افهم» on a plan request fails: the route answers 200 and the app expects 201 | `MAYBESITTER_FEATURE_GOAL_PLAN=true` | Private revision |
| 3 | CXA7.4 (S3) | The goal-plan add-on is checked on generate only, not on approve/confirm | `GOAL_PLAN=true` + `MAYBESITTER_ADDON_GATE_MODE=enforce` | Two private revisions |
| 4 | CA7.9 (S3) | A per-minute or global cap is shown as «خلصت خطط اليوم» with no retry | `MAYBESITTER_FEATURE_GOAL_PLAN=true` | Private revision |
| 5 | CXA11.4 (S3) | `POST /watchers` (football follow) skips the add-on gate | `MAYBESITTER_ADDON_GATE_MODE=enforce` | Private revision |
| 6 | CA9.9 (S3) | `google_feature_unavailable` is missing from the app's refusal enum, so the app shows a generic error | `MAYBESITTER_FEATURE_PROACTIVE_LOOP=false` + `MAYBESITTER_FEATURE_EMAIL_SOURCES=false` | Private revision |
| 7 | C12.16 (S3) | The Features screen goes blank when the probe flips to off while it is open | `MAYBESITTER_ADDON_GATE_MODE=off`, switched in while the screen is open | Private revision + proxy |
| 8 | CA6.6, CXA11.5 (S3) | The watcher sweep's football-off skip covers `fixture` watchers only; `football_team` watchers keep firing | `MAYBESITTER_ADDON_GATE_MODE=enforce` **in the sweep job** | Operator action (below) |
| 9 | CA6.5 (S3) | The held card routes to `calendarFeeds`, which renders nothing when ICS is off | App build with `EXPO_PUBLIC_FEATURE_ICS_FEEDS=false` | App build (below) |
| 10 | CA10.10 (S3) | M5a calendar settings show no "unavailable" line when `CALENDAR_READ` is off | App build with `EXPO_PUBLIC_FEATURE_CALENDAR_READ=false` | App build (below) |
| 11 | CX3.4 (S3) | A disabled Firebase user (403 `user_disabled`) is not signed out | An operator disables a QA user | Operator action (below) |
| 12 | C12.17 (S4) | A day whose activity kinds are all unknown gets a heading and no rows | A server newer than the app | Proxy or app build (below) |
| 13 | CXX1.6 (S4) | The Crashlytics `locale` attribute is set once | A release-like build with crash collection | App build (below) |
| 14 | CXX2.8 (S4) | Reduce Transparency is read after the first render on iOS | A release (LogBox-free) build | App build (below) |

"Bug present" below is what the audit predicts from the code. "Fixed" is the behaviour a fix should produce. Record the revision name, the overrides, the app build and the account, as the SHA-scoped evidence rules require (`evidence/UAT-EVIDENCE-INDEX.md`).

### Rows a private revision opens

**1. CXA1.3: MEMORY off between describe and confirm.**
`--name memoff --set MAYBESITTER_FEATURE_MEMORY=false`.
- **API.** Run `POST /api/mobile/profile/describe` on the **staging URL** (MEMORY is on there), then confirm that proposal with `POST /api/mobile/profile/describe/confirm` on the **tag URL**. The data is shared, so the proposal exists in both places. Expect 404 `feature_unavailable`, with no facts written (`GET /api/mobile/memory` on the staging URL).
- **Device.** Keep the app on the staging URL and add a proxy map-remote rule that sends only `…/profile/describe/confirm` to the tag URL. Run onboarding's describe step, then save.
- **Bug present:** the review clears and onboarding advances as if saved.
- **Fixed:** the app says the feature is unavailable and does not advance.

**2. CA7.2: «افهم» on a plan request.**
`--name plan --set MAYBESITTER_FEATURE_GOAL_PLAN=true`.
- **API.** `POST /api/mobile/intelligence {"text":"ابنيلي خطة أنزل بالوزن"}` on the tag URL. Expect **200** `{route:"plan_flow"}`; staging gives 201 with an observation.
- **Device.** Run an app with `EXPO_PUBLIC_API_BASE_URL=<tag URL>` and tap «افهم».
- **Bug present:** «في إشي عنا ما ردّ. جرّب بعد شوي.».
- **Fixed:** the plan flow opens.

**3. CXA7.4: goal-plan writes under enforce.**
You need two revisions: `--name plan --set MAYBESITTER_FEATURE_GOAL_PLAN=true` (gate still `shadow`), and `--name planenf --set MAYBESITTER_FEATURE_GOAL_PLAN=true --set MAYBESITTER_ADDON_GATE_MODE=enforce`.
- Make a plan draft through `qa-plan`, which lets the shadow gate generate.
- Then, with an account that is **not entitled** to the goal-plan add-on, approve and confirm the draft through `qa-planenf`.
- **Bug present:** approve and confirm answer 2xx and write.
- **Fixed:** both are refused with the add-on's locked response, and nothing is written.

**4. CA7.9: the minute cap shown as the daily cap.**
`--name plan --set MAYBESITTER_FEATURE_GOAL_PLAN=true`.
- Generate 9 plans within one minute on the tag URL. The 9th answers 429 `daily_cap_reached` with no scope.
- On the device, the app shows «خلصت خطط اليوم. بكرا منكمّل.» with no retry. A minute later, generation works again.
- **Fixed:** the copy names a short wait and offers a retry.
- **Cost:** up to 8 model calls per run on the shared caps. In the isolated staging project, `MAYBESITTER_AI_DISABLED=true`, so the model never runs there. Use `maybesitter-app` staging for this row, with the owner's go.

**5. CXA11.4: following a club with football off.**
`--name gate --set MAYBESITTER_ADDON_GATE_MODE=enforce`.
- On the tag URL, switch Football off for a QA account (`PUT` the features choice, or «الميزات» in an app pointed at the tag).
- Then `POST /api/mobile/watchers` with a football follow.
- **Bug present:** 2xx, and a follow and a watcher are written (fixture commitments may be projected).
- **Fixed:** the same locked response that football `GET`/`PUT` give.

**6. CA9.9: `google_feature_unavailable`.**
`--name nomail --set MAYBESITTER_FEATURE_PROACTIVE_LOOP=false --set MAYBESITTER_FEATURE_EMAIL_SOURCES=false`.
- `POST /api/mobile/integrations/google/connect` for `gmail` on the tag URL. Expect 403 `google_feature_unavailable`; staging answers 200 with an authorization URL.
- No Google sign-in is needed: the refusal comes before it.
- **Device.** Connect Gmail from an app pointed at the tag URL.
- **Bug present:** the generic «ما زبطت. جرّب كمان مرّة.».
- **Fixed:** a specific "not available" message.

**7. C12.16: the Features screen when the probe turns off.**
`--name gateoff --set MAYBESITTER_ADDON_GATE_MODE=off`.
- Keep the app on the staging URL (gate `shadow`) and open «الميزات».
- Enable a proxy map-remote rule that sends `…/capabilities/features` to the tag URL, then bring the app back to the foreground so the query refetches.
- **Bug present:** the screen goes blank (no rows, no message), and its entry disappears from the hub.
- **Fixed:** a message on the screen.

### Rows that need an app build or an operator action

These cannot be opened by server settings alone. Each one needs the owner's go where noted.

**8. CA6.6 / CXA11.5: the watcher sweep under enforce (operator).**
The sweep is the scheduled job `/api/internal/jobs/watchers`. It runs every minute on the **serving** revision, where the gate is `shadow`. The private revision does not change that, and a firing is keyed by (watcher, signal), so the serving sweep fires the club watcher first. Steps:
1. Create `--name gate --set MAYBESITTER_ADDON_GATE_MODE=enforce`.
2. QA account: follow a club whose team has a pending signal (news or a fixture change), then switch Football off.
3. **Owner's go:** pause the job `gcloud scheduler jobs pause watcher-sweep-staging --location=europe-west1 --project=maybesitter-app`. This pauses it for every staging user.
4. Call the sweep once on the tag URL with a scheduler token. The operator needs `iam.serviceAccountTokenCreator` on the scheduler account:
   ```bash
   TOKEN="$(gcloud auth print-identity-token \
     --impersonate-service-account=maybesitter-scheduler@maybesitter-app.iam.gserviceaccount.com \
     --audiences="<staging service URL>")"
   curl -X POST -H "Authorization: Bearer ${TOKEN}" "<tag URL>/api/internal/jobs/watchers"
   ```
5. Read the account's watcher firings (`GET /api/mobile/watchers`, or Firestore).
6. **Resume the job right away:** `gcloud scheduler jobs resume watcher-sweep-staging --location=europe-west1 --project=maybesitter-app`.
- **Bug present:** the `football_team` watcher fires.
- **Fixed:** it is skipped.

The Firestore emulator (`npm run test:emulator`) with the gate on `enforce` is the alternative that touches nothing shared.

**9. CA6.5: held card with ICS off (app build).**
1. Build or run Metro with `EXPO_PUBLIC_FEATURE_ICS_FEEDS=false`, against staging.
2. Use an account with an ICS-only held row: an ICS feed whose event clashes with a commitment, made earlier on a build with ICS on.
3. Tap the held card.
- **Bug present:** an empty `calendarFeeds` screen.
- **Fixed:** the card does not route there, or the screen explains itself.

**10. CA10.10: `CALENDAR_READ` off (app build).**
1. Build or run Metro with `EXPO_PUBLIC_FEATURE_CALENDAR_READ=false`.
2. Open the calendar settings in the M5a layout.
- **Bug present:** no `calendar-read-unavailable` line. The switches save, but nothing is read.
- **Fixed:** the unavailable line shows, or the switches are disabled.

**11. CX3.4: disabled user (operator).**
1. **Owner's go.** Disable a throwaway QA user in Firebase Auth (console, or Admin SDK `updateUser(uid, {disabled: true})`), never a real user.
2. Pull to refresh on Today.
- **Bug present:** the generic error with a Retry that keeps failing, for up to an hour.
- **Fixed:** the app signs out with a clear message.
3. Re-enable or delete the user afterwards.

**12. C12.17: an activity kind the app does not know (proxy or build).**
There are two ways:
- A proxy rewrite rule on `GET /api/mobile/activity` that changes every `kind` of one day to an unknown value (e.g. `future_kind`).
- An older app build against the current server, if the server has gained a kind since that build.

A private revision cannot do it, because it serves the same image.
- **Bug present:** a day heading with no rows under it, and no empty state.
- **Fixed:** the day is hidden, or the empty state shows.

**13. CXX1.6: Crashlytics locale (release build).**
1. A staging or release build with crash collection on (`docs/operations/CRASH_REPORTING.md`). An English-system phone, with Hebrew stored as the app language.
2. Cold launch, switch the language, then force a test crash.
- **Bug present:** the `locale` attribute in the Crashlytics console is the launch value and never follows the switch.
- **Fixed:** it follows the live language.

**14. CXX2.8: Reduce Transparency on cold launch (release build).**
1. A release (LogBox-free) build. Turn Reduce Transparency on in iOS settings.
2. Cold-launch and record the first 300 ms of the tab bar.
- **Bug present:** blur and gradients flash before solid surfaces.
- **Fixed:** solid from the first frame.

## Cleanup checklist

- `--remove qa-<name>` for every tag you made. `--list` should show none.
- Delete the revisions you no longer need (the command is printed by `--remove`).
- Resume any scheduler job you paused, and re-enable any Firebase user you disabled.
- Remove the proxy rules.
