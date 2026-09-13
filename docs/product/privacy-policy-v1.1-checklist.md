# Privacy policy v1.1 — contents checklist (UC-4.2, #177)

What the published policy must say, checked against **what the code actually
does on `main` today** rather than against the roadmap. Written for the owner
to approve; the owner publishes, and may take legal review first.

Two columns matter more than the rest:

- **Status now** — is this flow *implemented and reachable by a user today*?
- **How to phrase it** — a flow that does not exist yet must be described in the
  future tense or left out. A policy that describes planned behaviour as current
  is inaccurate in the direction that looks like over-collection, and it is the
  kind of inaccuracy a regulator reads as a disclosure failure rather than as
  optimism.

Verified against `main` at the time of writing (see "Evidence" per row).

---

## 1. Flows that exist today — describe in the present tense

### Firebase Authentication
**Status now: shipped.** Email/password, Google and Apple (`mobile/src/auth/`).

Must state: email address, display name where the provider gives one, the
provider's user id and the Firebase UID; that Apple's private relay address is
supported and is what we then hold; that Google Firebase stores it. Nothing is
copied into our own database — `lib/auth/mobileAuth.ts` deliberately writes no
email or display name into `users/{uid}`, so the policy should not imply we
hold a second copy.

### Firestore, under the signed-in account
**Status now: shipped.** `lib/storage/paths.ts` names every collection.

Must state, by name: commitments and the reminders derived from them; captures
held between proposing and confirming; the routine profile and memory facts
with their provenance; settings; consents; feedback the user gave; the audit
trail of consent and deletion events. Kept until the account is deleted.

Two honest details worth including because they are unusual and favourable:
capture proposals expire on their own (a TTL collection), and memory the user
states themselves does not expire on a timer — only they retire it.

### Gemini on Vertex AI
**Status now: shipped, consent-gated, and OFF in production.**
`infra/cloudrun/flags.sh:23,29` sets `MAYBESITTER_LLM_PROVIDER=gemini` for
staging and `none` for production.

Must state: what is sent (the text the user typed or dictated, the date, time
and time zone, and their self-description if they wrote one); to whom (Google
Cloud Vertex AI, EU region); why; that name, email, contacts, calendar and
location are never sent; that Google acts as a processor and the data is not
used to train models under the Vertex terms; and that consent is withdrawable
in Settings, taking effect on the next request with no cache in between.

**Phrasing note:** production currently sends nothing to any model. The policy
should describe the behaviour as it will be when the feature is enabled, and
must not claim it is currently happening for every user — the AI consent screen
already tells each person exactly what applies to them.

### Analytics
**Status now: shipped, consent-gated.** `lib/analytics/`.

Must state: counts and enum-valued properties only, never content; that the
event list is fixed server-side and anything else is refused; that nothing is
recorded until the analytics consent is granted.

### Rights, and deletion
**Status now: in-app deletion shipped (#149).**

Must state: access, correction and deletion; that deletion is a real delete of
the account tree and returns a receipt; the contact address; the Israeli
Privacy Protection Law basis.

**Not yet true:** a deletion page reachable *without installing the app*. That
is #179, and the URL does not exist. Do not state it until it does.

### Children
**Status now: n/a — a statement, not a flow.**
Must state that the service is not directed at under-18s.

### Changes to the policy
Must state how users are told. There is no in-app mechanism for this today, so
the honest phrasing is the site's "last updated" date plus notice on next
sign-in — not an in-app alert we do not send.

---

## 2. Flows that do NOT exist yet — future tense, or omit

Each of these appears in #177's original table. None is implemented on `main`,
and **none may be described as current**.

| Flow | Reality on `main` | Owner |
|---|---|---|
| Speech recognition | No speech dependency in `mobile/package.json` | #163 |
| Device calendar (busy times) | Not implemented | S3 #186 |
| Google Calendar | Dev-only verification demo, unreachable outside a development bundle (#152) | S3 #185 |
| Share extension | Not implemented | S3 #183 |
| FCM push | No messaging dependency in `mobile/package.json` | S3 #194, #198 |
| Home-screen widget | Not implemented; the widget analytics events exist in the contract but nothing emits them | S3 #203 |
| Crashlytics | No Crashlytics dependency in `mobile/package.json` | #180 (Agent A, unmerged at the time of writing) |

**Recommended approach for the owner:** publish v1.1 covering section 1 only,
with a short "What we may add" paragraph naming the categories in section 2 in
the future tense. Each becomes a present-tense section in the version that
ships alongside its feature. That keeps the policy true on the day it is
published, which is the only day it can be checked.

---

## 3. Where the app links to it

| Surface | Status |
|---|---|
| Sign-in screen, before any provider is pressed | Shipped (#151, locale-routed by #177) |
| Settings → Legal → Privacy policy / Terms of use | Shipped (#177) |
| Trust centre → Privacy policy | Waiting on the Trust centre screen (#174) |
| Account deletion screen | Shipped (#149), shows the deletion page link once one is configured |

Every one of them renders **nothing** until `EXPO_PUBLIC_LEGAL_BASE_URL` names
an https origin. Nothing in the app invents a domain, and a dead policy link is
worse than no policy link.

---

## 4. Blocked on the owner

- The domain, and publishing the site (#137). Until then `curl -sI` on the six
  URLs cannot return 200, so #177's last acceptance criterion cannot be met.
- Approving v1.1 against section 1 — a comment on #177 is enough.
- The privacy policy URL in App Store Connect and the Play Console, which
  needs the paid accounts (#158).

The `{{DOMAIN}}`, `{{LEGAL_NAME}}`, `{{SUPPORT_EMAIL}}`, `{{PRIVACY_EMAIL}}` and
`{{EFFECTIVE_DATE}}` placeholders in `site/` are still literal and greppable;
`site/PLACEHOLDERS.md` has the one-command replacement.
