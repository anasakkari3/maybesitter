# Round 2 polish — comparison report

Branch: `design/astra-r2-polish` in `code/astra-r2-polish`.

Starting SHA: `1e25b69bb120abd4a0c8e0e6cfcdd4ec2a4e6212`, verified as the current HEAD of `design/round-2-import` before creating the worktree. The final branch SHA is recorded in the delivered evidence manifest and handoff. No merge or push was performed. The original checkout's existing changes were left alone.

## Product changes

| Surface | Problem addressed and resulting behavior |
| --- | --- |
| Today / Next Step | The important commitment now has clearer title, context, and action hierarchy. Warm emphasis denotes “must”; secondary actions and ordinary information use neutral surfaces. Action rows stack as text grows. |
| Capture | A clearly bounded composer, quieter examples, simpler input tools, and a semantic prompt make the first action easier to scan. Examples give their space back once text exists. All input still enters the existing capture flow. |
| Clarification / Review | Neutral choices and explicit checked states distinguish selection from an AI proposal. Dashed proposal boundaries, the existing explanation, and explicit confirmation remain. Unselected content retains readable contrast. |
| Saved | A quieter confirmation mark and readable receipt replace the stronger glow. The receipt scrolls independently of its actions; Undo still uses the existing timed server operation. |
| Details | Shared Back control, clearer title/facts/history, and responsive action rows. At enlarged sizes the actions move into the scroller so they do not consume the entire viewport. Back stays pinned. |
| Postpone / Edit / confirmations | Bounded, scrollable sheets have an explicit translated Close control. Presets stack with enlarged text. Confirmation content scrolls and its actions adapt. No mutation semantics changed. |
| Daily Plan / Today plan row | A real shared icon, consistent spacing, readable times, responsive rows, and an announced explanation disclosure. A dashed proposal becomes a solid accepted summary only after the existing acceptance action succeeds. |
| Calendar | Neutral selected-day treatment with an explicit selected accessibility state, larger scalable day targets, horizontal week scrolling when needed, and responsive commitment rows. Existing busy/conflict sources remain intact. |
| Settings / appearance | Clearer group spacing, consistent row typography, directional chevrons, values below labels when text grows, isolated email addresses, and announced language/theme radio selection. Shared rows also improve the existing settings leaves. |
| Trust / Knows / Memory | Consent controls are grouped by purpose. Existing server-authoritative privacy claims remain conditional. Knows and the full Memory screen expose loading/failure/retry states; a network failure no longer claims that memory is empty. Memory facts, provenance chips, and actions are easier to scan. |

## Shared primitives and significant findings

- `theme/tokens.ts` adds semantic typography roles using the existing Round-2 ramp. The teal/sand palettes remain unchanged.
- `Txt` exposes page/section heading semantics and preserves Arabic line spacing. Simulator testing uncovered two native rendering mismatches: iOS Fabric already mirrors left/right alignment under RTL, and React Native already scales line height with font size. The old code applied both adjustments again. Alignment now mirrors once, and native scaling applies once to base font and line metrics. No text multiplier is capped.
- `ActionRow`, `BackButton`, `ChevronIcon`, quieter `Card`/`Tag`/`EmptyState`, and responsive `Notice` provide consistent composition without replacing navigation or state ownership.
- `Btn` preserves selected/checked/expanded states alongside disabled state and supports accessibility hints. Text links and memory actions have at least 44-point targets. Button, saved-mark, and sheet animations respect Reduce Motion.
- `Screen`/`ScreenScroll` retain safe-area ownership. Existing pinned TaskHeader/BackHeader behavior is preserved. The saved receipt is now scrollable inside its existing inset frame.

## Preserved deliberately

No changes to API hooks, endpoint clients, Firebase authentication, query ownership, Firestore persistence, contracts, recommendation rules, scheduling rules, consent semantics, localization dictionaries, or navigation topology. No fixtures or visual-only data were added to the runtime. Round-1 functionality retained by Round 2 remains available through the existing screens and server capabilities. The frozen web client and Stage B remain untouched.

Proposal → review → explicit acceptance, destructive confirmation, and existing reversible Undo behavior remain separate. Missing backend capabilities were not simulated: reopening completed commitments, duration/end-time data, commitment provenance, and unavailable data export remain their existing product gaps.

## Validation and evidence

[Open the before/after gallery](../../../../outputs/astra-r2-polish/index.html). Raw captures, successful Maestro flows, and validation logs are under the workspace's `outputs/astra-r2-polish/` directory. Images are real simulator captures; no UI was redrawn.

| Check | Result |
| --- | --- |
| Baseline mobile typecheck | Passed |
| Baseline full Jest | 197 suites, 2,663 tests, 1 snapshot passed |
| Final mobile `npm run typecheck` | Passed, with the original tracked tsconfig restored after Metro's automatic rewrite |
| Final full Jest | 198 suites, 2,674 tests, 1 snapshot passed |
| Relevant ESLint | 0 errors, 32 warnings; the same changed existing files had 39 warnings at the starting SHA |
| Design/contract regressions | Included in the complete mobile suite: token pins, screen-shell census, text scaling, RTL, localized copy, API fixture schemas, and interaction tests |
| Arabic runtime | Light and dark; Capture → Clarify → Review → Confirm, saved receipt, timed Undo; Details, sheets, drop confirmation/cancel, plan proposal/acceptance, Calendar, settings and trust |
| Other languages | English and Hebrew appearance, Today, Calendar; real Arabic commitment text retained to check mixed scripts and isolated times |
| Dynamic Type runtime | iOS xxxLarge (1.35×) and AX5 (3.12×). Details actions and sheet contents can be reached by scrolling while Back/Close stay visible. Capture's bottom action remains reachable with TaskHeader visible. |
| Memory runtime | Real manual memory created through the existing authenticated API; rendered provenance, “why” disclosure, and editing through the UI verified |
| Graphify | Scoped graph refreshed with `graphify update .` (AST only). The unrelated existing parser warning in `lib/recommendation/selector/candidates.ts` is recorded in the log. |

Runtime: signed existing development client, iPhone 17 Pro / iOS 26.5, Metro from this worktree, production backend build, Firebase Auth emulator and Firestore emulator. A disposable local account used the real SDK sign-in and authenticated routes. AI processing stayed off. The original commitment survived a backend restart. The existing Memory feature flag was enabled only in the local backend process to exercise that surface.

Baseline and after screenshots are not identical data-state comparisons: baseline includes the unverified-email banner and some development warning overlays; after captures use the verified test account, a generated/accepted plan, and additional explicitly confirmed test data. Those account/data differences are not UI changes. The gallery identifies the states and preserves original images. An initial memory smoke selector failed because of intentional bidi isolation; the corrected selector and successful flow are retained. Full Jest uses `--forceExit` because the baseline also retained open handles after completion.

## Remaining issues and verification limits

- AX5 remains a scroll-heavy experience by design. Its three-row Capture header is usable but still occupies substantial space; no text was reduced to conceal this.
- The full Memory screen now reports read failures correctly; the older compact MemorySection still has limited mutation feedback. Its behavior was not rewritten in this polish lane.
- The real Postpone action stored `postponedUntil` successfully (verified by an authenticated GET), but Details continues to display the original `timeSpec` due/reminder time. The existing `toViewModel` deliberately reads that field, not postponement. The distinction needs a product decision; this lane did not reinterpret the scheduling model.
- The existing development bearer override can satisfy the sign-in gate while API access uses the raw Firebase repository. This lane used genuine emulator SDK sign-in and did not change the auth architecture.
- Project-ID/emulator setup and the separate pilot/launch consent concepts remain unchanged. No backend storage/isolation or deployment work was attempted.
- This is iOS simulator evidence. Android device layout/TalkBack, a complete VoiceOver navigation audit, physical-device keyboard behavior, permission prompts, and real notification delivery were not certified. Reduce Motion behavior was checked in implementation/tests, not through a complete OS-setting runtime matrix.
- Remaining lint warnings concern existing React ref patterns and test `require()` imports. No lint errors were introduced.

The Round-2 artifacts, feature matrix, current code, native renderer sources, and scoped graph were reviewed. The repository's named design/React advisory skills were searched for but were not installed in this environment; repository contracts, functional tests, native-source verification, and direct simulator review were used. No merge is authorized or performed by this handoff.
