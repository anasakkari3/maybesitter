# Stitch Screen Map — Maybesitter Mobile

Mapping of Google Stitch design screens from project `projects/5784545255932247559` to Flutter implementation:

| Stitch Screen Title | Stitch Screen ID | Flutter Route | Flutter Widget | Implementation Status |
| :--- | :--- | :--- | :--- | :---: |
| **Today Home (iOS)** | `2a6d5aa283c94146b238638f3c316bbd` | `/today` | `TodayScreen` | Completed |
| **Today Home (Android)** | `faebd801b725425ca2f2eda0f6dc12bf` | `/today` | `TodayScreen` (adaptive) | Completed |
| **Upcoming Agenda (iOS)** | `c854adcf08bd437d8434f4273ee031d6` | `/upcoming` | `UpcomingScreen` | Completed |
| **Capture Composer (iOS)** | `cfbd84b33ab94ea280a965185de3b2b7` | `/capture` | `CaptureComposerScreen` | Completed |
| **Extraction Review (iOS)** | `f20c79e9624b40f68993219cc2022563` | `/capture/review` | `ExtractionReviewScreen` | Completed |
| **Clarification Sheet (iOS)** | `28d674e4bf014a789152db97970bb36e` | `/capture/clarification` | `ClarificationSheetScreen` | Completed |
| **Success Save (iOS)** | `395987245a344dd2be40de0edea9aca0` | `/capture/success` | `SuccessSaveScreen` | Completed |
| **No Commitment Found (iOS)** | `077ff78fa0b84d25ab1238de8581c508` | `/capture/review` (state) | `EmptyState` / `ExtractionReviewScreen` | Completed |
| **Maybesitter Commitment Planner** | `981ac5bbf768485bae98356215a2ae2f` | `/commitments/:id` | `CommitmentDetailsScreen` | Completed |
