repo: anasakkari3/maybesitter
branch: main
path: mobile/lib

## Last sync
date: 2026-09-10T13:11:26Z

### Updated in this project
- Read design tokens, Arabic strings, capture state machine and mock capture service as grounding for the redesign
- Built MaybeSitter prototype (fresh identity, Arabic-first) covering capture, day timeline, week calendar, close-out, rearrange, first move

## Screen map
| Screen | Repo files |
|---|---|
| Capture / Review / Clarify / Saved | mobile/lib/features/capture/*.dart, mobile/lib/models/capture_result.dart, mobile/lib/services/mock/mock_capture_service.dart |
| Day timeline (Today) | mobile/lib/features/today/today_screen.dart |
| Week calendar | mobile/lib/features/upcoming/upcoming_screen.dart |
| Rearrange sheet | mobile/lib/features/reminders/postpone_sheet.dart, mobile/lib/features/commitment_details/commitment_details_screen.dart |
| First move | mobile/lib/features/next_step/next_step_card.dart |
| Strings (ar/en/he) | mobile/lib/l10n/app_localizations_*.dart |
| Tokens (reference only) | mobile/lib/design_system/tokens/*.dart, mobile/docs/design-system.md |
