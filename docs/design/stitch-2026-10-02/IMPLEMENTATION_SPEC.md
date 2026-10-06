# Stitch redesign — implementation spec (mobile/, React Native)

Owner decision 2026-10-02: the Stitch design in this folder replaces the
current visual design of the mobile app. The previous design is archived at git
tag `archive/pre-stitch-design` (= main `ee82d011`). Behaviour, data, backend
calls and third-party integrations are NOT being rewritten: this is a visual and
information-architecture migration on top of the working app.

Reference per screen: `html/*.html` (exact Stitch markup — Tailwind classes give
colours, sizes, radii, spacing) and `png/*.png` (390-px renders).

## Non-negotiables
1. Keep every backend/API call, query hook, mutation, provider and host exactly
   as it works today. Restyle and re-arrange; do not re-implement data paths.
2. Copy comes from the i18n files (`mobile/src/i18n/...`), plain spoken Levantine
   for Arabic. New strings are added to ar + en + he together. Never paste Stitch
   copy that contradicts an existing product string; prefer the existing string.
3. Product rules: models only propose (nothing changes without explicit
   confirm); never silently pick a date/time; «مش هلّق» ≠ drop; no streaks, no
   praise, no guilt; AI disclosure stays («مين بيفهم كلامك»); calendar shows busy
   time only (no event names where the product contract says busy-only).
4. RTL first. Hebrew keeps Noto Sans Hebrew.
5. Accessibility: text ≥ 12 px (tab labels, chips, footnotes ≥ 13), body 15–16,
   buttons 15–16; every control ≥ 44×44 hit area; contrast ≥ 4.5:1 for text.
   Text scale must still work (no capped fonts, no clipped labels).
6. Keep existing `testID`s where the element still exists (device flows and
   tests rely on them). New elements get stable testIDs.
7. The repo's tests are part of the deliverable: `cd mobile && npx tsc --noEmit`,
   `npx jest` (full), `npx expo lint --no-cache` (if configured) must be green.
   Update tests that assert old visuals; never delete a behavioural assertion to
   make a test pass.

## Tokens (theme/tokens.ts)
Dark (default — see Theme):
- background `#0E1526`, surface `#172036`, surfaceAlt/raised `#1F2A44`
- text `#F3F5FA`, muted `#A9B2C7`, border `rgba(169,178,199,0.16)`, borderStrong `rgba(169,178,199,0.40)`
- brand/accent coral `#FF6B6B`, onBrand `#0E1526` (navy text on coral), brandContainer `rgba(255,107,107,0.15)`, brandPressed `#FF8A8A`
- must/attention amber `#F5B547`, container `rgba(245,181,71,0.15)`
- success green `#4CC38A`, container `rgba(76,195,138,0.15)`, onSuccess `#0E1526`
- bar `rgba(23,32,54,0.96)`, barSolid `#172036`, overlay `rgba(0,0,0,0.55)`
Light:
- background `#F7F5F1`, surface `#FFFFFF`, surfaceAlt `#F0EDE7`, border `#E6E1D8`
- text `#1A1F2B`, muted `#5B6375`
- brand `#C2394A` with WHITE onBrand, brandContainer `#FBE3E6`, chip text `#A8323F`
- amber text `#7A5200` on `#FDF1DA`; green text `#1E6B45` on `#E2F5EA`
Priority chips: «لازم» coral, «مهم» amber, «حلو» green; busy/fixed = neutral grey.
Radii: cards 20, chips/pills 999. One palette for every screen (retire the
separate "reference" and capture-chat palettes by pointing them at these values).

## Type
Arabic: Noto Kufi Arabic (`@expo-google-fonts/noto-kufi-arabic`).
Latin + digits: Plus Jakarta Sans (`@expo-google-fonts/plus-jakarta-sans`).
Hebrew: Noto Sans Hebrew (unchanged). Keep the per-script font mapping and the
font-coverage tests; update them for the new faces.
Raise the smallest steps: nothing below 12; tab labels and chips 13.

## Theme
Dark is the hero. A user with no saved preference gets dark. Light remains
available in Settings → Language & appearance, and "system" still works.

## Information architecture
Bottom bar: «احكيها» (capture, shown as the app's mark) · «اليوم» (today) ·
«الخطة» (calendar/plan) · «أشيائي» (things) · «يتابع لك» (watching, with a
badge count) — five equal items. **Owner delta 2026-10-06:** «احكيها» moved
from a pill floating centred above a four-item bar into the bar as its first
item, with the app's mark in place of its text; it opens the existing
capture flow and keeps the `tab-capture` testID. Settings is
opened from the avatar in each tab header (first letter of the user's name),
renders WITHOUT the tab bar, and its back returns to the tab it was opened
from (hardware back too). Content gets bottom padding so the bar never covers
a row. At the accessibility (xl) text sizes the bar is two rows (three items,
then two) so every label keeps its full size.
- «أشيائي» hub: search, entries Commitments (full list) · Goals · Habits ·
  «عم تفكّر فيه» (seeds/ideas), and «آخر ما حفظته». Built from existing screens
  and queries (commitments, goals, habits, seeds). Football stays a commitment
  type (football icon, no completion circle). Places & financial context stay
  in Settings.
- «يتابع لك» hub: questions, suggestions (proactive loop), watches
  (background activity/watchers) with last-check status, «شو بيعرف عنك» link,
  «وقّف كل المتابعة مؤقتًا» if the product supports pausing. Uses existing
  intelligence/watch endpoints.

## Screens (reference file → existing code)
- Today `01-today-dark` / `01b-today-light` → `screens/TodayScreen.tsx` (+ next
  step card, conflict line, groups). «بلّش فيها» marks started (never done),
  «خلصتها» completes, «مش هلّق» opens the postpone sheet («إمتى نرجّعها؟»).
  Conflict line on two lines, opens a conflict explanation, not postpone.
- Empty + offline `01c` → Today empty state + `api/ui/OfflineBanner`.
- Plan `02-plan` → `screens/CalendarScreen.tsx` + `screens/PlanScreen.tsx`
  (week strip with load word, filters, proportional timeline, proposals with
  explicit confirm, «التزامات بلا وقت»).
- Capture `03`, `03b` → `features/capture/*` chat (review cards with «ينحفظ»
  checkbox, save label follows selection, stay in chat after save with undo,
  clarification quick replies, listening state with stop/cancel).
- Things `04` → new hub screen; Detail `04b` → `screens/DetailsScreen.tsx`
  (drop vs delete distinct, confirm sheets).
- Watching `05` → new hub screen.
- Settings `06` → `screens/SettingsScreen.tsx` + category screens.
- Onboarding `07` → `features/onboarding/*`; Sign-in `08` → `SignInScreen`,
  `EmailAuthScreen`.
- Every other screen (settings leaves, sheets, dialogs, toasts) inherits the
  new tokens/fonts and must look consistent (cards, chips, buttons).
