# S2 checkpoint — code reconciled, not code complete

- **Date:** 2026-09-13
- **SHA:** `541dcefedd43d7aa32c564da777709b505b06088`
- **Tag:** `checkpoint/s2-reconciled`
- **Verdict:** **S2 CLOSURE INCOMPLETE** — deliberately, and the tag name says so.

The tag is not called `s2-code-complete` because S2's code is not complete, and a
checkpoint that claimed otherwise would be the exact defect this closure existed
to remove. What *is* true at this SHA: every S2 issue has been checked against
the code rather than against its own checklist, every gate passes on this tree,
and nothing legitimate is stranded outside `main`.

## What the gates said, on this SHA

Run on a worktree created fresh from `origin/main` with a real `npm ci` — not on
a developer checkout, and not on an earlier tree.

| Gate | Result |
|---|---|
| `check:no-flutter` | pass |
| `check:test-registration` | pass |
| `typecheck` (root) | pass |
| `npm test` (root) | **4009 passed, 0 failed** |
| `test:contracts` | pass |
| `build` | pass |
| `shellcheck` | pass |
| Firestore + Auth emulator suite (`test:emulator:attach`) | **50 passed, 0 failed** |
| mobile `tsc --noEmit` | pass |
| mobile `expo lint --no-cache` | **0 errors**, 71 warnings (unchanged from the S2 baseline) |
| mobile `jest --runInBand` | **79 suites / 1050 passed, 0 failed** |
| mobile `check:no-credentials` | pass |
| mobile `check:privacy-manifests` | pass |
| production config guard (no API URL) | refuses, as designed |
| production config guard (with API URL) | accepts |
| production build + `EXPO_PUBLIC_ENABLE_TEST_CRASH` | refuses, as designed |

Baseline at the start of closure was 3978 root tests and 71 suites / 952 mobile
tests. The deltas are the work below, not churn.

### Reproducing it

```sh
git fetch origin --tags
git worktree add --detach /tmp/s2-verify checkpoint/s2-reconciled
cd /tmp/s2-verify && npm ci
npm run check:no-flutter && npm run check:test-registration
npm run typecheck && npm test && npm run test:contracts && npm run build
shellcheck scripts/*.sh infra/**/*.sh

# emulator suite — alternate ports so a running pair elsewhere is untouched
node -e "const c=require('./firebase.json'),e=c.emulators||{};c.emulators={...e,firestore:{...e.firestore,host:'127.0.0.1',port:8231},auth:{...e.auth,host:'127.0.0.1',port:9231},ui:{enabled:false}};require('fs').writeFileSync('.firebase-local.json',JSON.stringify(c,null,2))"
npx --yes firebase-tools@14 emulators:start --only firestore,auth \
  --project demo-maybesitter --config .firebase-local.json &
FIRESTORE_EMULATOR_HOST=127.0.0.1:8231 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9231 \
  GCLOUD_PROJECT=demo-maybesitter npm run test:emulator:attach

cd mobile && npm ci
npx tsc --noEmit && npm run lint -- --no-cache && npm test -- --runInBand
npm run check:no-credentials && npm run check:privacy-manifests
```

## What landed during closure

| PR | What it fixed |
|---|---|
| #322 | The theme preference was held in `useState`, so every cold start came back to System. Now persisted, with a test that unmounts and remounts the provider. (#155) |
| #323 | Seventeen parity-table rows still read "In flight" for work merged weeks earlier, and nine documents still carried runnable `flutter test` commands under a `mobile/` path that is now the React Native app. (#175) |
| #324 | `clarification_answered` had a port and no implementation, optional-chained so nothing could ever go red. The store is real and the dependency is now **required**, so a construction site that forgets it does not compile. (#165) |
| #339 | Three copy guards that acceptance criteria named and nobody wrote: clarification key coverage against the server contract and all three locales, the ≤8-word question cap, and the ≤10-word next-step cap plus the sensitive-lexicon check. (#165, #170) |
| #340 | The source-map hook was never invoked, so symbolication could not work; there was no `ErrorBoundary`; and there was no way to trigger a test crash at all. All three fixed, with a build-time guard that refuses the trigger in production. (#180) |
| #341 | `executedEngine` was `z.string()` while the contract declares three values — the acceptance criterion was unfalsifiable rather than met. (#160) |
| #342 | A quota refusal showed "something went wrong" because the composer never called `userFacingMessage`; and `kill_switch_active` rendered a generic error *with a Retry button*, which is the loop a kill switch exists to stop. (#181, #170) |
| #343 | The mobile capture funnel was unmeasured. `capture_submitted` and `capture_confirmed` are now derived server-side from committed state — deliberately not client-reportable, so activation progress cannot be forged — and `capture_undone`, which is inherently client-side, goes through the consented client path. (#172) |
| #230 | Cleared GHSA-w5vr-8v7q-w6rv: `baseline-browser-mapping` 2.10.15 → 2.11.21. |

Every one of these carried a mutation check: the fix was broken on purpose and
the new tests were confirmed red before being restored. A test that cannot fail
for its own defect has bitten this repository before.

## Work recovered

Two pieces of unique work existed nowhere on the remote and are now preserved as
pushed tags:

- `archive/2026-09/stranded/local-main-launch-site` — a local-only commit on the
  main checkout, mislabeled "#174", actually holding a launch marketing site, an
  early-access backend, brand assets, **and a Hermes `Intl` polyfill fix**.
  Hermes ships no `Intl.PluralRules` or `Intl.Locale`, so every `{n, plural, …}`
  rendered as raw ICU source on device while Jest, running on Node's full `Intl`,
  stayed green. That fix is **not** on `main` — see the deferred list below.
- `archive/2026-09/stranded/s00-dataset-registry-uncommitted` — 374 insertions of
  uncommitted calibration gold-freeze work found in a side worktree, captured
  through a temporary index so the worktree and its own index were never touched.

## S2 implementation issues

**Closed — repository work complete, external work split out:**
#160, #162, #163, #165, #167, #170, #174, #175, #178, #179, #180, #181

**Open — because executable code is genuinely still missing:**

| Issue | What is actually missing | Owned by |
|---|---|---|
| #161, #166, #169 | The Hebrew UI render. `Lang = 'ar' \| 'en'`, and the app ships no Hebrew font face, so `he` would render as tofu | #335 |
| #164 | The `EditProposalItemSheet` RNTL test (RTL + localized pickers) | #338 |
| #168 | The RNTL test for the AI-declined onboarding branch | #338 |
| #171 | The `i18next/no-literal-string` lint rule on the onboarding tree | #338 |
| #172 | The clipboard import sheet; `.maestro/capture.yaml` | #336 |
| #173 | `features.safeCommitmentPatch` does not exist — PATCH is sent unconditionally; the details sheet has no time fields and `buildTimePatch` has zero production callers | #337 |
| #176 | iOS AppIcon dark and tinted variants | #338 |
| #177 | `.maestro/legal-links.yaml` | #338 |
| #182 | The "Release log" table in `mobile/README.md` | #338 |

No issue is open merely because a human must click something. That was the point.

## External follow-ups created

Owner: #325 (ar/he permission strings), #326 (privacy policy v1.1), #327
(over-declared iOS data types), #328 (GCP budgets, quota, IAM, session metric),
#329 (production deploy for the next step), #334 (four stale acceptance criteria).
Paid: #330 (Gemini evaluations on real Vertex). Store: #331 (App Store Connect
and Play Console). Device: #332 (the S2 flows on real hardware). Domain: #333
(legal and deletion pages on a real domain). Pre-existing and still owning their
scope: #137 (domain), #158 (store accounts), #159 (tester recruitment).

## Deferred, and worth naming

- **The Hermes `Intl` polyfill is not on `main`.** It is a real, device-visible
  defect in shipped code — plural strings render as raw ICU source — and the fix,
  with a regression test that deletes `Intl.PluralRules` before loading the
  module, exists only on the archive tag above. It was left out of this closure
  because the commit carrying it also contains a marketing site, vendored
  minified third-party JS and ~3.5 MB of screenshots, none of which belongs in
  "AI pipeline + core screens". **It should be cherry-picked on its own, first
  thing in S3.**
- The launch site, the early-access backend and the brand-asset replacement from
  that same commit are S4 scope and have no issue yet.

## Branches and worktrees

`main` is the only active development branch. 204 stale refs were deleted (112
local, 92 remote) after each was verified three ways: ancestry, a merged PR
record, or tree-identity with an archive tag.

Deliberately kept:

- `origin/backup/flutter-canonical-d0c865c` — the pre-migration Flutter history.
- Six `origin/dependabot/*` branches with open PRs.
- All 102 `archive/*` tags. These are load-bearing: twelve branches' worth of
  commits exist nowhere else, including a 9,441-line dataset-registry and
  calibration stack that never reached `main`.

53 worktrees were removed. Two remain: the canonical checkout, and
`maybesitter-s00-dataset-registry`, kept because another session may own it —
its uncommitted work is archived, so nothing there is unique any more.

## One thing that is not ours

`/Users/anasakkari/Desktop/1-Projects/MaybeSitter/.git` is a **separate 250 MB
repository with zero commits**, holding `refs/codex/turn-diffs/checkpoints/…`.
It is ChatGPT/Codex's checkpoint store, not this project's. It is what made the
product checkout appear to have hundreds of untracked files — the product repo
itself is clean and was clean before this closure began. Do not delete it and do
not `git clean` against it.
