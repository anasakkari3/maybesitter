# Google Calendar verification demo (UC-1.8 #152)

Development only. This exists to be filmed for a Google OAuth reviewer.

## Reaching it

Three conditions, all required:

1. a development bundle (`__DEV__`);
2. `APP_ENV=development`;
3. `EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO=true` in **your own `.env.local`** —
   never an EAS variable.

Then open `maybesitter://calendarDemo`.

A staging or production build that sets the variable at all **fails to
configure** (CFG-1), so the demo cannot reach anyone but the person filming it.
`__tests__/demoGate.test.ts` asserts each gate separately, and
`src/config/__tests__/appConfig.test.ts` proves the build refusal through a
real `expo config` run.

## The scopes are the submission

`scopes.ts` holds the two strings the verification covers. **Changing either
means a new review.** A feature that needs more access waits for that review;
it does not edit the list.

| Scope | Used for |
|---|---|
| `calendar.events` | read when the user is busy (start and end only), and — only on an explicit confirm — write commitments they confirmed |
| `calendar.calendarlist.readonly` | list calendar **names**, so the user chooses which count as busy |

Not requested: `calendar` (full access, including sharing and deleting
calendars) and `calendar.readonly` (broader than a list). Neither requested
scope is restricted, so no CASA assessment applies.

The request enforces the justification rather than promising it:
`calendarList` is fetched with `fields=items(id,summary)`, so the response
*cannot* contain anything but ids and names, and busy time comes from
`freeBusy`, whose response has no field for a title.

## What still needs the owner

None of this can be submitted from here.

1. **OWNER-A1 (#137)** — buy the domain, publish `/`, `/privacy` and `/terms`,
   and verify it in Search Console from a Google account with Owner on
   `maybesitter-app`. Everything below depends on it.
2. Enable the **Google Calendar API** in `maybesitter-app`.
3. **Branding**: name `MaybeSitter`, a 120×120 logo with no Google marks, the
   home/privacy/terms URLs on the real domain, and authorized domains
   `<domain>` + `maybesitter-app.firebaseapp.com`.
4. **A user support email and a developer contact address.** The console only
   accepts a Google account or Group the owner controls. Neither belongs in
   this repository or in an issue.
5. **Audience: External → In production.** "Testing" caps at 100 users and
   expires refresh tokens after 7 days.
6. **Data access**: add the scopes above and attach a screenshot of the scope
   table with the sensitivity column visible.
7. **Record the video** on a development build on a real device, following the
   script in #152, and upload it to YouTube as Unlisted.
8. **Submit** in the Verification Center, and answer reviewers within two
   working days.

Never film the retired Flutter app: its bundle ids and OAuth clients will not
ship.
