# Maestro flows

`smoke.yaml` is the "does the app actually start" check. It launches the app,
asserts the Arabic Today and capture labels are on screen, switches to the
calendar tab and back.

## Run it

Maestro drives an installed build, not the Metro bundler, so install a build
first:

```bash
# iOS simulator or Android emulator with a development build installed
maestro test .maestro/smoke.yaml
```

With a development build, start Metro in another terminal (`npm start`) so the
JS bundle is served.

## Why the assertions are Arabic

Arabic is the default language (`src/i18n/strings.ts`), so a fresh install shows
Arabic labels. If the build is misconfigured, the CFG-1 screen appears instead
of the app and these assertions fail — which is the point.

## `auth-gate.yaml`

UC-1.7 (#151)'s claim, on a device: a fresh install lands on sign-in, and
`openLink maybesitter://today` while signed out still lands on sign-in rather
than the app. It then opens the email flow and comes back.

Run it against a build with `EXPO_PUBLIC_DEV_BEARER_TOKEN` **unset**. With the
local override active the app starts signed in, which is correct behaviour and
not what this flow is testing.

```bash
maestro test .maestro/auth-gate.yaml
```

## Targeting the auth fields

Both inputs on the email screen carry a `testID`:

```yaml
- tapOn:
    id: 'authEmailInput'
- inputText: 'someone@example.com'
```

Match on those rather than on the visible label. The labels are localised, and
each field's caption repeats its own label — so `tapOn: 'الإيميل'` is both
locale-dependent and ambiguous.

The same ambiguity bites buttons whose label repeats the screen heading:
`tapOn: 'إنشاء حساب'` on the sign-up screen can hit the heading instead of the
button. Use `tapOn: { point: … }`, or add a `testID`, when a label is not
unique.

## What Maestro cannot drive here

`inputText` delivers only **one character** into a `secureTextEntry` field on
the iOS simulator. So a flow cannot complete a real sign-up or sign-in end to
end — it gets as far as a one-character password, which the screen correctly
refuses before any network call.

That path is covered instead by `src/auth/__tests__/emailAuth.test.ts` (RNTL,
against `FakeAuthRepository`) and by exercising Firebase's own REST API
directly. A flow that appears to sign in on a simulator is not evidence.

## Locale

These flows assert Arabic strings, so run them on a device whose language
resolves to Arabic:

```bash
xcrun simctl spawn <udid> defaults write -g AppleLanguages -array ar
xcrun simctl spawn <udid> defaults write -g AppleLocale -string ar_JO
xcrun simctl shutdown <udid> && xcrun simctl boot <udid>
```

On an English device the app renders English and every assertion fails for the
wrong reason.

## `delete-account.yaml`

UC-1.5 (#149)'s entry point and its confirmation, on a device: Settings →
Account → Delete account in two taps, the screen stating what is deleted and
what is kept, and the confirmation alert whose default is Cancel.

**It stops at Cancel on purpose.** Carrying on would really delete the
account — there is no undo and no grace period — so the destructive half is
verified against staging with a disposable account rather than from a flow
anyone might run twice.

Sign in by hand before running it: `inputText` cannot fill a secure field on
the simulator (see above), so the flow cannot reach Settings on its own.

```bash
maestro test .maestro/delete-account.yaml
```

## `today.yaml` (UC-2.R3, #173)

Seeds one commitment through capture, then does to it everything the details
screen offers: postpone by a preset, edit the title, decline a drop-on-purpose,
and delete.

Two assertions in it are about restraint rather than function. The review screen
must say «هذا اقتراح. لم يتغيّر أي شيء بعد.» before anything is saved, and
declining the drop confirm must leave the commitment exactly as it was.

It needs a **signed-in** build. Maestro cannot type into a secure field, so it
cannot sign in by itself and a pass here is not evidence that sign-in works.

## `next-step.yaml` (UC-2.9 #170, UC-2.R3 #173)

Opens the "why", defers by a preset, dismisses, and accepts.

It asserts the suggestion notice is present unconditionally, and — the point of
running it on a device at all — that no English evidence label leaks onto an
Arabic screen. `evidenceLabels` travel in the same response as the codes the
card renders, so `assertNotVisible: 'overdue'` is what catches a fallback to
them.

It needs recommendation consent granted **in onboarding** (the launch consent),
not the Trust switch. Without it the card does not appear at all, which is
correct, and the flow then fails for the right reason.

## `capture.yaml` (UC-2.R2, #172)

The capture journey from the entry a widget uses:
`openLink maybesitter://capture?source=widget&input=voice`, then type, understand,
review, confirm, and take the undo.

Two assertions in it are about restraint. Review must say «هذا اقتراح. لم
يتغيّر أي شيء بعد.» before anything is written, and pressing Paste must open a
sheet rather than filling the field — the clipboard is read on that press and
on nothing else, so no "pasted from …" banner appears before it.

The paste half branches on both answers on purpose: a simulator's pasteboard
is not ours to assume, so the flow accepts either the preview or the "nothing
to paste" line and cancels out of whichever it got. Setting the pasteboard and
asserting the pasted text lands in the field is
`src/features/capture/__tests__/captureClipboard.test.tsx`, which can do it
deterministically.

It ends by taking the undo, which deletes what it just saved — so the flow
leaves no commitment behind and can be run twice.

Needs a **signed-in** build, and a device that can reach the API. Maestro
cannot type into a secure field, so it cannot sign in by itself.

```bash
maestro test .maestro/capture.yaml
```

## `capture-edit.yaml` (UC-2.4, #164)

The review screen's edit sheet. Renames the item, picks a level, opens the
time wheel, saves, cancels a second edit, and only then confirms.

The assertion it exists for is the one after Save: the card shows the new title
and «هذا اقتراح. لم يتغيّر أي شيء بعد.» is *still* on screen. The edit is held
and travels with the confirm (#164), not PATCHed behind the user, so a build
that wrote early is a build where that line has gone.

The wheel is opened and never spun. A Maestro swipe on a native spinner lands
on whichever row it lands on, so a flow that then asserted a time would be
asserting the swipe. Changing the instant deterministically is
`src/features/capture/__tests__/editProposalItemSheet.test.tsx`; reading it in
Arabic, in the right face and direction, is `…/editProposalItemSheetRtl.test.tsx`.

It ends by taking the undo, so it leaves no commitment behind.

## `clarify.yaml` (UC-2.5, #165)

One capture the extractor cannot resolve, walked twice: skipped once, answered
once. The input names an action and no time on purpose.

What it checks that a unit test cannot: that the question is rendered from the
app's own locale files. `edit-item-sheet` appearing instead of
`clarify-question` means the server's `questionKey` was unrecognised and the
fallback took over, and any English on that screen means the sentence came from
the server rather than from `ar.json`.

If the server resolves the input anyway there is no question to ask and the
flow fails at `clarify-question`. That is the honest failure: the clarification
path would then be unreachable for this input, which is worth knowing.

## `memory.yaml` (UC-2.7a #167, UC-3.16 #202)

Settings → Trust Centre → «شو بيعرف MaybeSitter», then add, edit, open the full
memory screen, and forget.

**It branches at the top on purpose.** `MemorySection` renders nothing at all
when `GET /api/mobile/memory` answers 404, which is what a build with the
memory feature off gets. A flow that asserted the section exists would fail on
a correct build, so the "off" branch asserts the absence is total instead.

The second half is `MemoryScreen` (#202), which did not exist when #167 was
written: the same records grouped by who asserted them, each able to say why it
is there. Delete means different things on the two surfaces — the card confirms
and cannot be taken back, the screen removes the row at once and holds the
request for five seconds — so both are walked, and the screen's undo is taken
so the card still has a record to delete for real.

Every row selector reads `memory-…-mem_.*`. A record's id is `mem_<uuid>`, and
a bare `memory-delete-.*` also matches `memory-delete-all`: on a list of one,
the wrong match is a flow that empties the account instead of testing a row.

## `plan.yaml` (UC-3.10b, #195)

`maybesitter://plan/<date>` → today's plan: the reasoning card, the order of the
day, an item's editor, "Looks good", and the morning-plan switch in Settings →
Notifications.

**It does not prove the acceptance criterion it looks closest to.** "Tapping the
plan-ready push on a killed app opens that date's plan" needs #184's APNs key
and a physical handset. `openLink` fires the same deep link the notification
tap resolves to, so it exercises the router and the screen — not the delivery,
not the tap, and not a cold launch from a killed process. Read a pass here as
"the link works", never as "the notification works".

The date is `plan.today`'s own (`2026-08-09`) rather than today's: the mock
adapter serves one fixture per route, so asking for any other day would render
that same plan under the wrong heading.

The refusal path is absent for the same reason. A 422 needs the server to hold
constraints the move collides with, and the adapter keeps no state — so
`plan-item-refused-…` is Jest's to prove (`PlanScreen.test.tsx`), not Maestro's.

The Today card (`today-plan-card`) is the one entry point only a device shows
in place: mock mode answers every date with `plan.today`, so the card renders
that plan under today's heading. Jest holds what the card *decides* — nothing
while loading, nothing on an error, nothing once somebody has said "not today"
(`TodayPlanCard.test.tsx`); this flow only shows that it is reachable and opens
the right screen.
