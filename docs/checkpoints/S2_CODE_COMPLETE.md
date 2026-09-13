# S2 — code complete

- **Date:** 2026-09-14
- **Tag:** `checkpoint/s2-code-complete`
- **Predecessor:** `checkpoint/s2-reconciled` (`fda1cda`, 2026-09-13) — kept as the
  historical reconciliation point and deliberately not moved.
- **Verdict:** **S2 CLOSURE COMPLETE.** Zero executable S2 implementation work
  remains. Everything still outstanding needs a device, a store console, a paid
  account, an owner decision or a domain, and each lives on its own issue.

The reconciliation checkpoint said, honestly, that S2 was *not* code complete:
eleven issues were open because repository work was genuinely missing. This one
says the opposite, and the difference is nine merged pull requests rather than a
change of definition. Nothing was moved to S3 to make a milestone look finished.

## What the gates said, on the tagged SHA

Run on a worktree created fresh from `origin/main` with a real `npm ci`.

| Gate | Result |
|---|---|
| `check:no-flutter` | pass |
| `check:test-registration` | pass |
| `typecheck` (root) | pass |
| `npm test` (root) | **4016 passed, 0 failed** |
| `test:contracts` | pass |
| `build` | pass |
| `shellcheck` | pass |
| Firestore + Auth emulator suite | **50 passed, 0 failed** |
| mobile `tsc --noEmit` | pass |
| mobile `expo lint --no-cache` | **0 errors**, 71 warnings (unchanged all sprint) |
| mobile `jest --runInBand` | **91 suites / 1177 passed, 0 failed** |
| mobile `check:no-credentials` | pass |
| mobile `check:privacy-manifests` | pass |
| production config guard — no API URL | refuses |
| production config guard — with API URL | accepts |
| production config guard — test-crash flag | refuses |

S2 opened at 3978 root tests and 71 suites / 952 mobile tests. It closes at 4016
and 91 / 1177.

### Reproducing it

```sh
git fetch origin --tags
git worktree add --detach /tmp/s2-verify checkpoint/s2-code-complete
cd /tmp/s2-verify && npm ci
npm run check:no-flutter && npm run check:test-registration
npm run typecheck && npm test && npm run test:contracts && npm run build
shellcheck scripts/*.sh infra/**/*.sh

# emulators on alternate ports, so a pair running elsewhere is untouched
node -e "const c=require('./firebase.json'),e=c.emulators||{};c.emulators={...e,firestore:{...e.firestore,host:'127.0.0.1',port:8261},auth:{...e.auth,host:'127.0.0.1',port:9261},ui:{enabled:false}};require('fs').writeFileSync('.firebase-local.json',JSON.stringify(c,null,2))"
npx --yes firebase-tools@14 emulators:start --only firestore,auth \
  --project demo-maybesitter --config .firebase-local.json &
FIRESTORE_EMULATOR_HOST=127.0.0.1:8261 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9261 \
  GCLOUD_PROJECT=demo-maybesitter npm run test:emulator:attach

cd mobile && npm ci
npx tsc --noEmit && npm run lint -- --no-cache && npm test -- --runInBand
npm run check:no-credentials && npm run check:privacy-manifests
APP_ENV=production npx expo config --type public                       # must fail
APP_ENV=production EXPO_PUBLIC_API_BASE_URL=https://x npx expo config --type public   # must pass
```

## What closed the gap

| PR | Gap |
|---|---|
| #347 | Hermes ships no `Intl.PluralRules`, so every `{n, plural, …}` rendered as its own ICU source on device while Jest stayed green on Node's full `Intl`. Ported from the archive tag **without** the marketing site it was bundled with. |
| #348 | `EditProposalItemSheet` and the AI-declined onboarding branch both worked and neither had a test watching them (#164, #168). |
| #349 | iOS AppIcon dark and tinted variants, a runnable `legal-links` Maestro flow with a CI validator, and the release log (#176, #177, #182). |
| #350 | `features.safeCommitmentPatch` did not exist and PATCH was unconditional; the details sheet could not edit time at all and `buildTimePatch` had zero production callers (#173). |
| #353 | Clipboard import through the real capture machine, and `.maestro/capture.yaml` (#172). |
| #354 | The capture field accepted 200 characters while the confirm refused over 120 — and one invalid edit fails the *whole* confirm (#351). |
| #355 | Hebrew became a language the app can be put into, not just one it carries copy for (#161, #166, #169). |
| #356 | `i18next/no-literal-string` on the onboarding tree, as an error (#171). |

Every one of these carried a mutation check: the fix was broken on purpose and
the new tests confirmed red before being restored. Across the sprint that is
roughly 130 mutations. This repository has shipped regression tests that could
not fail for their own defect before, and that is the practice that catches it.

### Three defects found by writing the tests, not by the audit

- **#351** (fixed, #354) — the title-length mismatch above.
- **#352** (open, S3) — `PATCH` accepts a past time the capture path refuses.
  Enforcing it turns three registered tests red, one of which *writes* the
  committed contract fixtures the whole mobile suite parses. Named rather than
  half-fixed.
- Four Hebrew bugs the compiler could not see (#355): three screens aligned
  their text on `lang === 'ar'` and so left Hebrew left-aligned inside an RTL
  screen; `links.ts` silently dropped `?lang=he`; the voice chip had rendered
  «עברית» as tofu since #163.

## S2 implementation issues

**All closed.** #160, #161, #162, #163, #164, #165, #166, #167, #168, #169,
#170, #171, #172, #173, #174, #175, #176, #177, #178, #179, #180, #181, #182.

The milestone contains no open issue with executable code.

## What remains, and who it belongs to

Owner: #325 (ar/he permission strings), #326 (privacy policy v1.1), #327
(over-declared iOS data types), #328 (GCP budgets, quota, IAM, session metric),
#329 (production deploy for the next step), #334 (four stale acceptance
criteria), #335 (native Hebrew review and device pass).
Paid: #330 (Gemini evaluations on real Vertex), #158 (store accounts).
Store: #331. Device: #332. Domain: #333, #137. Recruitment: #159.

S3 code dependencies: #336 (capture follow-ons), #337 (commitment details),
#338 (remaining mobile test and config gaps), #352 (the PATCH past-time rule).

## Repository state

`main` is the only active development branch. Kept deliberately:

- `origin/backup/flutter-canonical-d0c865c` — pre-migration Flutter history.
- Six `origin/dependabot/*` branches with open PRs, each needing a human call.
- All 99 `archive/*` tags. These are load-bearing: twelve branches' worth of
  commits exist nowhere else, including a 9,441-line dataset-registry and
  calibration stack that never reached `main`, and the launch-site commit that
  carried the Hermes fix.

Two worktrees: the canonical checkout, and `maybesitter-s00-dataset-registry`,
whose uncommitted work is archived at
`archive/2026-09/stranded/s00-dataset-registry-uncommitted`.

## One thing that is not ours

`/Users/anasakkari/Desktop/1-Projects/MaybeSitter/.git` is a **separate ~250 MB
repository with zero commits**, holding `refs/codex/turn-diffs/checkpoints/…`.
It is ChatGPT/Codex's checkpoint store. It is what makes the product checkout
look as though it has hundreds of untracked files; the product repository itself
is clean. Do not delete it and do not `git clean` against it.
