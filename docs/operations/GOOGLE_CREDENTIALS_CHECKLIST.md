# Google Calendar / Gmail / Drive — owner credential checklist (CL6a)

Everything up to the credentials is built. Until the steps below are done, the
status route answers `not_configured` and the app shows one line on the Google
page and on the three Integrations rows:
«ربط Google بستنّى إعداد من صاحب التطبيق». There is no connect button in that state.

No code change is needed. The three secrets in §5 are read at request time: a
missing secret is re-checked within a minute (60 s negative cache), and a
secret it has found is cached for five minutes. **But two environment variables
are also required, and setting an environment variable on Cloud Run creates a
new revision** (a redeploy of the same image, not a rebuild): the KMS key in §6
on both services, and the redirect URI in §3 on production. Until §6 is done
the status route keeps answering `not_configured`, whatever secrets exist.

Every name below is taken from the code, as listed in "Where each fact lives"
at the end. Never paste a secret value into chat, an issue, or a commit.

## 1. APIs to enable (project `maybesitter-app`)

- Google Calendar API: `POST https://www.googleapis.com/calendar/v3/freeBusy`
- Gmail API: the bounded scan
- Google Drive API: `files.get` for metadata, `alt=media`, and `export` as `text/plain`
- Google Picker API: the picker page loads `https://apis.google.com/js/api.js`

## 2. Google Auth Platform (the OAuth consent screen)

- **Audience:** user type **External**, publishing status **Testing**. Add
  each Google account that will connect as a **test user**. Testing mode allows
  at most 100 test users.
- **Data access:** add exactly these scopes. They are the only ones the code
  requests:
  | Feature | Scope |
  |---|---|
  | identity (asked every time) | `openid`, `https://www.googleapis.com/auth/userinfo.email` |
  | Calendar | `https://www.googleapis.com/auth/calendar.freebusy` |
  | Gmail | `https://www.googleapis.com/auth/gmail.readonly` |
  | Drive | `https://www.googleapis.com/auth/drive.file` |

  Scopes are requested incrementally, one feature at a time
  (`include_granted_scopes=true`). Every authorization also sends
  `access_type=offline` and `prompt=consent`.
- **Testing mode lasts 7 days.** In Testing mode, Google expires refresh tokens
  after 7 days. The server records this as `needs_reauth`, and each row the
  grant covered then shows «أعد الربط». One tap asks again for every feature
  that grant held. This is expected behaviour, not a defect.
- **Before a public launch:**
  - `gmail.readonly` is a **restricted** scope. It needs Google verification
    **and** a paid annual CASA security assessment. If the answer is no, Gmail
    stays test-users-only.
  - Check how the Data access page classifies `calendar.freebusy`. If it is
    listed as sensitive, it needs Google verification, which is free but takes
    weeks and needs a homepage and privacy policy on a verified domain.
  - `drive.file` is neither sensitive nor restricted. It needs brand
    verification only.

## 3. OAuth client

- **Credentials → Create OAuth client ID → type: Web application.** Calendar,
  Gmail and Drive all share this one client.
- **Authorized redirect URIs**: the path is fixed in code as
  `/api/oauth/google/callback`. Register it on each origin that will run the
  flow:
  - staging: `https://<staging Cloud Run URL>/api/oauth/google/callback`
  - production, when wanted: `https://<production Cloud Run URL>/api/oauth/google/callback`
  - local simulator runs: `http://localhost:3000/api/oauth/google/callback`

  How the server builds the URI it sends to Google (`redirectFrom` in
  `googleConfig.ts`):
  1. `GOOGLE_OAUTH_REDIRECT_URI`, if it is set. It must be `https`, or `http`
     on `localhost`/`127.0.0.1`.
  2. Otherwise `MAYBESITTER_INTERNAL_AUDIENCE` + `/api/oauth/google/callback`.
     `infra/scheduler.sh` sets `MAYBESITTER_INTERNAL_AUDIENCE` to the service
     URL, **but only where it has been run**:
     - staging has it, so staging needs nothing extra. Its redirect URI is
       `https://maybesitter-api-staging-xw5vhndxxq-ew.a.run.app/api/oauth/google/callback`
       (read-only check by the CL6a reviewer, 2026-09-26) — register exactly
       that.
     - **production (`maybesitter-api`) has no `MAYBESITTER_INTERNAL_AUDIENCE`**
       (same check: only `GOOGLE_CLOUD_PROJECT` among the relevant variables).
       Without a redirect URI the production status stays `not_configured`, so
       set it explicitly when production is wanted:

       ```
       PROD_URL="$(gcloud run services describe maybesitter-api --region europe-west1 \
         --project maybesitter-app --format='value(status.url)')"
       gcloud run services update maybesitter-api --region europe-west1 --project maybesitter-app \
         --update-env-vars "GOOGLE_OAUTH_REDIRECT_URI=${PROD_URL}/api/oauth/google/callback"
       ```

       This creates a new production revision. Register the same URI on the
       OAuth client first.

  The URI must match the registered one character for character. The Picker
  page is served from the same origin, at `/api/oauth/google/picker`.
- The **project number** is not configured anywhere. The code reads it from the
  numeric prefix of the client ID and uses it as the Picker app ID.
- Android emulator note: Google accepts plain `http` only for `localhost`, so a
  local run in the Android emulator (which reaches the host as `10.0.2.2`)
  cannot complete consent. Use the iOS simulator or staging.

## 4. Picker API key

- **Credentials → Create API key.** Under **API restrictions**, allow only the
  **Google Picker API**.
- Do **not** add an HTTP-referrer application restriction. The picker page is
  served with `Referrer-Policy: no-referrer`, so it sends no referrer for such a
  restriction to match.
- Without this key, Calendar and Gmail still work, and the Drive row says
  «اختيار ملف من Drive بستنّى إعداد من صاحب التطبيق».
- Known limit: the access token the Picker page holds is the grant's own, so
  when Gmail is also connected it carries `gmail.readonly` as well as
  `drive.file`. Google documents no way to narrow a refreshed token, and a
  `drive.file`-only token would need a second consent per pick. The page is
  bounded instead: single-use two-minute ticket, `no-store`, `no-referrer`,
  nonce CSP (reasoning in `googleDrive.ts`, `redeemDrivePickTicket`).

## 5. Secret Manager: the exact names the server reads

On Cloud Run (`K_SERVICE` set, with `MAYBESITTER_GCP_PROJECT` or
`GOOGLE_CLOUD_PROJECT`), the server reads `versions/latest` of:

| Secret name | Value |
|---|---|
| `google-oauth-client-id` | the Web client's ID (`<project-number>-….apps.googleusercontent.com`) |
| `google-oauth-client-secret` | the Web client's secret |
| `google-picker-api-key` | the Picker API key from step 4 |

Create each secret and add its value without echoing it. For example:

```
printf '%s' "$VALUE" | gcloud secrets versions add google-oauth-client-secret --data-file=- --project maybesitter-app
```

Then grant the runtime service account read access to **each of the three**
secrets. The existing bindings are per secret (see `infra/bootstrap.sh`):

```
gcloud secrets add-iam-policy-binding <name> --project maybesitter-app \
  --member=serviceAccount:maybesitter-run@maybesitter-app.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

The server treats a 403 (no accessor role) the same as a 404 (no secret):
both mean `not_configured`, and neither causes an error.

For local runs, environment variables override Secret Manager:
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`GOOGLE_PICKER_API_KEY` and `GOOGLE_OAUTH_REDIRECT_URI`.

## 6. The token encryption key (required, and not in place today)

Tokens are stored only after KMS envelope encryption
(`lib/security/fieldEncryption.ts`). Without the key the chain reports
`not_configured` **before** anyone reaches Google's consent screen — so this
section is as much a credential step as §5.

**What is live today** (read-only check by the CL6a reviewer, account
`anasakkari05@`, 2026-09-26; nothing was changed):

- `MAYBESITTER_KMS_KEY_NAME` is **not set** on `maybesitter-api-staging` or on
  `maybesitter-api`.
- The **Cloud KMS API is not enabled** on project `maybesitter-app`
  (`gcloud kms keyrings list` answers PERMISSION_DENIED, "API not enabled").
  So no key ring or key exists yet.
- Pre-existing, not introduced by this lane: the calendar-feed (ICS URL)
  encryption of UC-3.4 (#188, `lib/calendar/icsFeeds.ts`) uses the **same**
  key through the same module, so ICS feed subscriptions have never been able
  to store a URL on staging either. These steps fix both.

**What the code expects:**

- `MAYBESITTER_KMS_KEY_NAME` is the full CryptoKey resource name,
  `projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>`,
  passed as-is to `KeyManagementServiceClient.encrypt/decrypt`. No key
  version: encryption uses the primary version and decryption reads the
  version from the ciphertext, so rotation needs no change here.
- A **symmetric** key (purpose `ENCRYPT_DECRYPT`): the module wraps a random
  per-field AES-256 key with KMS `encrypt`, binding it to the uid and purpose
  as additional authenticated data.
- The name the code's own tests and comments use
  (`lib/security/inMemoryKms.ts`) is
  `projects/maybesitter-app/locations/europe-west1/keyRings/maybesitter/cryptoKeys/user-secrets`.
  `europe-west1` matches Firestore, Cloud Run and Vertex (`infra/bootstrap.sh`,
  `infra/cloudrun/flags.sh`), so the keys live in the same region as the data
  they protect. The client uses the global KMS endpoint, which serves every
  location.

**Steps** (run by the owner; each changes project state):

```
# 1. Enable the API.
gcloud services enable cloudkms.googleapis.com --project maybesitter-app

# 2. Key ring and key. A key ring and a key can never be deleted, only their
#    versions destroyed, so type the names once and correctly.
gcloud kms keyrings create maybesitter --location europe-west1 --project maybesitter-app
gcloud kms keys create user-secrets --keyring maybesitter --location europe-west1 \
  --purpose encryption --rotation-period 90d \
  --next-rotation-time "$(date -u -v+90d +%Y-%m-%dT%H:%M:%SZ)" \
  --project maybesitter-app
#    (GNU date: date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)

# 3. Let the runtime service account (the one §5 already uses) wrap and
#    unwrap with this key, and nothing else.
gcloud kms keys add-iam-policy-binding user-secrets --keyring maybesitter --location europe-west1 \
  --project maybesitter-app \
  --member serviceAccount:maybesitter-run@maybesitter-app.iam.gserviceaccount.com \
  --role roles/cloudkms.cryptoKeyEncrypterDecrypter

# 4. Point each service at it. Each command creates a new revision of that
#    service (same image, new environment); traffic moves to it when it is ready.
KEY=projects/maybesitter-app/locations/europe-west1/keyRings/maybesitter/cryptoKeys/user-secrets
gcloud run services update maybesitter-api-staging --region europe-west1 --project maybesitter-app \
  --update-env-vars "MAYBESITTER_KMS_KEY_NAME=${KEY}"
# production, when wanted:
gcloud run services update maybesitter-api --region europe-west1 --project maybesitter-app \
  --update-env-vars "MAYBESITTER_KMS_KEY_NAME=${KEY}"
```

The variable survives later deploys: `infra/cloudrun/flags.sh` passes
`--update-env-vars`, which merges into the service's environment rather than
replacing it (`--set-env-vars` would erase this). It is still worth adding to
`flags.sh` in a later change so a service recreated from scratch gets it; this
lane did not touch `infra/cloudrun/flags.sh`.

Check (read-only):

```
gcloud run services describe maybesitter-api-staging --region europe-west1 --project maybesitter-app \
  --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep MAYBESITTER_KMS_KEY_NAME
```

## 7. Firestore TTL

`infra/firestore-ttl.sh` now covers `providerOAuthStates` (unfinished
authorizations, about 10 minutes) and `googlePickerTickets` (2 minutes). Both
are keyed on `expiresAt`. The owner runs it; it was not run from this lane.

## 8. Smoke test after setup (staging)

1. `curl -sI 'https://<staging>/api/oauth/google/callback?error=access_denied'`
   → `302`, `location: maybesitter://oauth/google?error=access_denied`,
   `cache-control: no-store`.
2. In the app: Settings → Integrations. The Google Calendar, Gmail and Drive
   rows no longer show the not-configured line. Open the Google page: each row
   shows **Connect** («اربط»). If the line is still there after a minute, one of
   steps 3–6 is missing: client ID/secret, redirect URI, or KMS key.
3. **Calendar:** tap Connect. Google's consent screen asks only for
   "See your free/busy" and your email. Approve it. The row shows
   «مربوط · <email>». Turn the calendar on in the Trust Center if asked, then
   «حدّث الأوقات المشغولة». A meeting in the next 14 days shows as busy time on
   the Calendar tab, and Today's plan avoids it. A meeting the phone's calendar
   already shows is not drawn twice.
4. **Gmail:** tap Connect on Gmail. Google asks only for Gmail read access, and
   Calendar stays connected. With AI processing on, «جيب التزامات من إيميلي»
   opens the review screen with proposals from the last 7 days of Primary (at
   most 20 messages). Nothing is saved until you confirm. If the model was
   stopped part-way (a quota), the page or the review says «قرينا N من M إيميل
   بس» rather than "nothing to save".
   **Then check the grant survived:** at least an hour after connecting Gmail
   (so the access token has expired), tap «حدّث الأوقات المشغولة». It must
   succeed, and the Calendar row must not turn into «أعد الربط». Adding a
   feature never revokes the combined grant (CL6a review C1); this is the
   first place a regression would show.
5. **Drive:** tap Connect on Drive, then «اختار ملف من Drive». Google's picker
   opens. Pick one Google Doc or PDF. The review screen opens with its
   proposals.
6. **Reconnect:** remove MaybeSitter at https://myaccount.google.com/permissions.
   Then refresh busy times in the app. The rows show «أعد الربط». Tap it and
   approve; every feature comes back.
7. **Disconnect:** «افصل Google» → confirm. MaybeSitter disappears from
   myaccount.google.com/permissions, the Google busy time leaves the Calendar
   tab, and every row shows Connect again.
8. **Account deletion:** delete a test account that has Google connected. The
   grant is revoked at Google first, then its tokens and connection documents
   are deleted.

Consent must be entered by hand with the owner's own Google password, once per
test account. Simulator automation cannot type into Google's secure fields.

## Where each fact lives

- Secret and env names, scopes, callback/picker paths, the redirect rule, and
  the caches: `lib/integrations/google/googleConfig.ts`
- `access_type=offline&prompt=consent&include_granted_scopes=true`:
  `lib/integrations/google/googleOAuthClient.ts`
- Freebusy 14 days: `lib/integrations/google/googleCalendarBusy.ts`
- Gmail query `category:primary newer_than:7d`, 20 messages:
  `lib/integrations/google/googleGmailScan.ts`
- Drive types, the picker ticket and the page:
  `lib/integrations/google/googleDrive.ts`, `googleBrowserPages.ts`
- KMS key variable: `lib/security/fieldEncryption.ts` (`MAYBESITTER_KMS_KEY_NAME`);
  the intended key name: `lib/security/inMemoryKms.ts`
- Production path allow-list for the two browser pages: `src/middleware.ts`
