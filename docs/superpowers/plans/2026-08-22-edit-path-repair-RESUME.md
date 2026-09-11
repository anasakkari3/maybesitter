# Resume point — full debt repair

Stopped deliberately on 2026-08-23, mid-item-#10. Everything below is measured,
not remembered.

## Where the work lives

- Worktree: `.worktrees/full-debt-repair` (created off `main` @ `06df808`)
- Branch: `fix/full-debt-repair`
- HEAD when stopped: `2df2771`
- Working tree: clean apart from untracked `REPAIR_LEDGER.md` and this file
- `main` itself is untouched — nothing here has been merged

## Gate status at the stopping point

| Gate | Baseline before any work | Now |
| --- | --- | --- |
| `npm test` | 3249 pass / 0 fail | **3278 pass / 0 fail** |
| `npm test` under `TZ=UTC` | not measured | **3278 pass / 0 fail** |
| `npm run typecheck` | ❌ 1 error | **0 errors** |
| `flutter test` | 394 pass / 1 skip | **422 pass / 1 skip / 0 fail** |
| `flutter analyze` | 5 warnings | **5 warnings** (same 5, `test/unit/in_memory_repository_test.dart:99-103`) |
| `npm run capture:eval` | 14 cases, 3 of 6 thresholds asserted by the test | **17 cases, all 6 asserted, 100%** |

## Items

| # | Item | Status |
| --- | --- | --- |
| 12 | analytics privacy allowlist (found during baseline) | ✅ done — `59a4c3a` |
| 7 | alpha-trace session isolation | ✅ done — `9ebd009`, `a973575`, `e12a5e0` |
| 4 | `update`/`cancel`/`delete` not durable | ✅ done — `16037e0` |
| 11 | timezone shift on a hosted server | ✅ done — `7db2bbd` (server), `48c4c5a` (client) |
| 6 | time edit marked "Postponed" | ✅ done — `48c4c5a` |
| 5 | `endTime` incoherent | ✅ done — `d7ec91b` |
| 1 | silent commitment loss + false confidence | ✅ done — `a1fe5d6` |
| 3 | eval gate + multilingual corpus | ✅ done — `3324cb0` |
| 8 | tests blind to the default configuration | ✅ done — `7587f37` |
| 9 | pilot build flags unpinned | ✅ done — `7587f37` |
| — | independent review round, all findings addressed | ✅ `5ad4e72` |
| 10 | localization leakage | 🔶 **in progress — resume here** |
| 2 | hosted backend | ⛔ not started; externally blocked (see below) |

## Item #10 — exactly where to pick up

Seven keys exist in all three ARB files and are generated. **No call site uses
them yet.** That is the next edit.

| Key | Replace the literal at |
| --- | --- |
| `recentCommitments` | `mobile/lib/features/capture/capture_composer_screen.dart:412` |
| `overdueBadge` | `mobile/lib/design_system/components/commitment_card.dart:211` |
| `tryAgainAction`, `extractionFailedTitle` | `mobile/lib/design_system/components/error_state.dart:18,21` (defaults) — note `extraction_review_screen.dart:32,45` construct `ErrorState` without `retryLabel`, which is how the English default reaches Arabic and Hebrew |
| `stationaryOnDevice` | `mobile/lib/design_system/components/processing_indicator.dart:16` (`helperText` default; the label at :15 is already overridden at `capture_composer_screen.dart:404`) |
| `closeAction` | `mobile/lib/design_system/components/maybesitter_bottom_sheet.dart:74` |
| `noDateSet` | `mobile/lib/core/utilities/date_formatter.dart:52,90,95` |
| `fullDay` | `mobile/lib/core/utilities/date_formatter.dart:100,110,115` |

`date_formatter.dart` is the awkward one: it is a plain utility with no
`BuildContext`. It already has an l10n-aware twin (`formatHeaderDate` at :68
beside the non-localized :57), so follow that existing shape rather than
inventing a new one.

After wiring, write the no-leakage test that does not exist yet: render Today,
capture, and the detail screen under `ar` and `he` and assert none of the
replaced literals appear. `mobile/test/widget/rtl_accessibility_test.dart` looks
like it covers this and does not — it renders *English* content under
`TextDirection.rtl` and asserts `find.text('Maybesitter')`, so it cannot detect
leakage. `v03_localization_rtl_test.dart` is the better model: it asserts via
`l10n.*` getters.

Then regenerate goldens **only** if the diff is intended, and look at the images
before accepting them. 13 goldens live in `mobile/test/goldens/goldens/`; four
are locale-specific (`today_arabic.png`, `today_hebrew.png`,
`capture_composer_arabic.png`, `arabic_large_text.png`, `hebrew_large_text.png`).

### Still-leaking sites not yet covered by those seven keys

Found by audit, all with file:line, none fixed:

- `mobile/lib/services/flutter_local_notifications_gateway.dart:172,255-257,263-265,277-280` — **every** native reminder string: channel name, the `I know` / `Later` / `Done` action buttons, three titles, three bodies. Zero l10n. Highest-impact remaining group: these are what a participant sees on the lock screen.
- `mobile/lib/models/activity_event.dart:19-39` — 11 `defaultTitle`s, rendered raw by `activity_screen.dart:100`.
- `mobile/lib/services/mock/mock_activity_repository.dart:19-34` — seeded Activity entries. **Reachable in every build**: `activityRepositoryProvider` (`providers.dart:114-116`) returns the mock unconditionally, unlike `commitmentRepositoryProvider`.
- `mobile/lib/services/soft_awareness_reminder_engine.dart:343,362,379,390` — four activity descriptions.
- `mobile/lib/services/api/mappers/proposal_mapper.dart:27,33,39,41` — clarification prompt, `Confirm as proposed`, two error messages. On the **default** path.
- `mobile/lib/features/capture/extraction_review_screen.dart:103,112`, `capture_controller.dart:405,494,501,528-529,539`.
- `mobile/lib/design_system/components/clarification_card.dart:59`, `extraction_review_card.dart:98,174,182,215,216`.
- `mobile/lib/features/settings/settings_screen.dart:197`, `mobile/lib/models/app_settings.dart:21`, `mobile/lib/models/pilot_presence.dart:72`.
- Seed commitment titles in `in_memory_commitment_repository.dart:126-215` — **not** reachable in a default build (that path returns `ApiCommitmentRepository`), so lower priority than they first appear.

Separately: `mobile/lib/l10n/app_localizations{,_ar,_en,_he}.dart` is a stale
orphan of `lib/l10n/generated/` (114 getters vs 403) that nothing imports.
Deleting it is cleanup, not translation work.

## Item #2 — hosting, and why it is not merely unstarted

The intended target is **not** Vercel. `docs/operations/V03_PILOT_OPERATIONAL_DEPLOYMENT.md:26-49` specifies **Google Cloud Run with a mounted Cloud Filestore volume and `max-instances=1`**, and says why: the participant write queue is process-local, so a second writer corrupts state. The backend persists to the filesystem throughout (`.maybesitter/**` via `MAYBESITTER_DATA_DIR`), so a stock serverless deploy would lose every write.

What exists: `src/app/api/health/route.ts` (liveness only — it does not touch the data dir, so it reports healthy on an unmounted volume), a complete `process.env` inventory in the audit, and the deployment doc. What does not exist: any `vercel.json`, `Dockerfile`, `render.yaml`, `fly.toml`, or CI. `.github/` holds only an issue template.

**The external blocker is real:** deploying needs a Google Cloud project, billing, and credentials that are not present in this environment. Config and smoke tests can be written without them; the deploy itself cannot be performed or verified here, and must not be claimed as done.

Also binding: the deployment doc's own status line says it *does not authorize pilot deployment*, and #7's fix is a prerequisite for any shared backend with tracing enabled — that one is now satisfied on this branch.

## Two findings worth carrying forward

1. **A new extractor defect, found while building the corpus and left unfixed.**
   `الأربعا الجاي عند الحلاق الساعة 6` with reference Monday 2026-07-27 resolves
   to **Monday 27** at 06:00, not Wednesday 29. The Arabic weekday phrase is not
   honoured, and `الأربعا الجاي` is also left in the title. Not added to the
   corpus, because the multilingual threshold is 100% and a known-failing case
   would hold the gate red for everyone. Deliberately not hidden either — it is
   recorded here and in `REPAIR_LEDGER.md`.

2. **A case I mislabelled and corrected.** I first added the Arabic
   multi-time sentence as a `forbidden.inventedTime` safety case. That was
   wrong: the input genuinely contains `الساعة 9`, so extracting it is not
   invention — it is incomplete extraction. The runner's check is "remindAt must
   be null", which that input should not satisfy. Removed from the corpus; the
   real behaviour is covered by `tests/extraction/multiTimeSafetyValve.test.ts`.

## How to resume

```bash
cd <repo>/.worktrees/full-debt-repair
git log --oneline 06df808..HEAD      # 12 commits of work
npm test && npm run typecheck        # expect 3278 / 0
cd mobile && flutter test            # expect 422 / 1 skip
```

Then start at the wiring table under item #10 above.
