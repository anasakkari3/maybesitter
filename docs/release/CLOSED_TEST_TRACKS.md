# TestFlight and the Play closed track (UC-4.6a, #182)

What is configured in the repository, and what only a person with the accounts
can do. Everything in the second list is blocked on OWNER-A2 (#158).

## Configured here

- `version: '1.0.0'` in `app.json`, with EAS-managed build numbers
  (`appVersionSource: 'remote'`, `autoIncrement` on the production profile). A
  build number chosen by hand is a build number that collides once.
- `eas.json` → `submit.production.android`: **`track: 'alpha'`**, which is
  "Closed testing – Alpha". Not `internal`: that is a different, smaller
  audience, and the closed-test roster (#159) opts in through the alpha track's
  own URL.
- `releaseStatus: 'draft'`, so a submission never goes live to the track by
  itself. Promoting is a decision, and an automated pipeline should not be able
  to make it.
- The in-app feedback channel: the per-card flag on the next-step card
  (UC-2.R3 #173, shipped), five categories and an optional note.

### Credentials are deliberately absent

There is no `serviceAccountKeyPath`, no team id and no app id in `eas.json`.

Placeholder values would look configured and fail at submit time with a
confusing error, and a real path invites somebody to put a service-account JSON
in the repository. `npm run check:no-credentials` fails the build if one ever
appears — it is a gate, not a reminder.

Instead:

```
eas credentials -p ios          # App Store Connect API key, App Manager role
eas credentials -p android      # upload keystore, generated and held by EAS
eas secret:create --scope project --name GOOGLE_SERVICE_ACCOUNT_KEY --type file --value <path>
```

Back the Android upload keystore up to the owner's password manager at first
creation. Losing it means a new app listing, not a new key.

## Only a person with the accounts can do these

Blocked on #158, and none of them is code:

1. **Apple** — create the App Store Connect record (`com.maybesitter.app`, SKU
   `maybesitter-ios-v1`), run the first `eas build -p ios --profile production`
   so App IDs and capabilities are registered, and verify App Groups, Push,
   Sign in with Apple and Time Sensitive Notifications in the Developer portal.
   Create an APNs key and upload it to Firebase Cloud Messaging.
2. **TestFlight** — Test Information (beta description, feedback email, the
   privacy policy URL from #177, demo sign-in, review notes), the group
   "Closed test Oct–Nov 2026" with the #159 iOS testers, and Beta App Review.
   No public link.
3. **Play** — create the app, complete App content per #179, a minimal listing,
   then **upload the first AAB by hand**: Google requires one manual upload
   before API submissions work. Later builds go through
   `eas submit -p android`.
4. **Testers** — the email list, the opt-in URL, and the onboarding message
   sent individually or by broadcast list. Not a group chat: testers must not
   see each other's contacts.
5. **The Google Form** feedback channel, with email collection set to *do not
   collect*.

## What "ready" means before any of that

- `eas build -p android --profile production` produces an AAB whose permissions
  match `verify-release-android.sh`.
- A release build launches, signs in, captures and confirms on a real device.
- Crash reports arrive symbolicated (#180) — which itself needs one of these
  tracks, so it is checked on the first build rather than before it.
