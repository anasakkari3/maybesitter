# Store accounts — owner checklist (OWNER-A2, #158)

**PAID OWNER ACTION, DEFERRED.** Apple is $99/year and Google Play $25 once.
The owner has deferred anything requiring payment; nothing here has been
started and no account has been created.

This file exists so that when the owner does start, the sequence is already
worked out and the only thing left is the part only they can do. Claude must
not enter credentials, payment details or ID documents, and has not.

## The deadline, and why it is the real one

Accounts must be **active by 2026-10-20**, which means starting by **2026-10-01
at the latest**. Apple's identity check and Google's identity *and* device
verification each take several business days and neither can be hurried. A slip
past 10-20 does not cost a few days — it pushes the closed test (2026-10-28),
which must run 14 consecutive days, which pushes production access, which
pushes the 2026-12-06 launch.

This is the one dependency in the whole plan that cannot be parallelised or
worked around, because it is a queue at somebody else's counter.

## Verified against the repository, 2026-09-13

- The app is `mobile/`, one identifier on both platforms: **`com.maybesitter.app`**
  (`mobile/app.config.ts`). #182 registers it; nothing here does.
- Signing is managed by EAS (`eas credentials`), so there is no Xcode signing
  setup to do by hand.
- The Flutter project's old `DEVELOPMENT_TEAM` and identifiers are retired with
  the client itself (see `docs/migration/flutter-to-rn-parity.md`) and do not
  apply. **Do not paste a team id into a public issue.**

## The decision already taken: individual, not organization

An organization account needs a registered legal entity and a D-U-N-S number —
free, but 5–14 business days, which does not fit before 10-20.

**The consequence to accept:** the owner's **legal name appears publicly** as
the seller/developer on both stores. It is reversible later — Apple through a
membership transfer, Google by creating an organization account and
transferring the app — but not quickly, and not before launch.

A personal Play account created after 2023-11-13 must also pass the
**12 testers × 14 consecutive days** rule, which is #204's problem and is why
#159's recruitment matters.

## Before starting — about ten minutes

1. An Apple Account with **two-factor authentication**, in the legal name that
   matches the government ID.
2. A dedicated Google account for publishing, with 2-Step Verification and a
   recovery method. A fresh one used only for MaybeSitter, so that losing
   access to a personal account never means losing the app.
3. Government photo ID, legal home address, phone number.
4. A payment card. **$99/year Apple, $25 once Google.**
5. A support email alias on the domain (#137). Both stores show the developer
   email publicly, so it must not be a personal address.
6. An Android phone the owner physically has. A new personal Play account must
   verify a real device through the Play Console app.

Items 5 and 6 are the ones people discover too late. The support alias needs
the domain, which is #137 — also deferred — so **#137 blocks the tidy version
of #158**, and a personal address can be used and changed later if it comes to
that.

## Apple Developer Program

1. Apple Developer app → Account → Enroll Now. In-app ID scanning is usually
   fastest; `developer.apple.com/programs/enroll` is the alternative.
2. **Individual / Sole Proprietor.** Scan ID, confirm name and address, pay $99.
3. Wait for "Welcome to the Apple Developer Program", usually 24–48 h. If Apple
   asks for documents, reply the same day — the queue restarts otherwise.
4. App Store Connect → Business: accept the Program License Agreement. The
   free-apps agreement is enough; there are no in-app purchases.
5. **EU trader status (DSA):** v1 is Israel-only (#205), so declare non-trader
   and keep the EU out of availability. Declaring trader status pulls in
   obligations the product does not need yet.
6. Users and Access: the owner only, as Account Holder. #182 later creates an
   App Store Connect **API key** for EAS Submit. **That key goes into EAS
   credentials — never into chat, never into this repository.**

## Google Play Console

1. `play.google.com/console/signup` → **Yourself** (personal) → pay $25.
2. **Identity verification**, then contact phone and email verification.
3. Install the Play Console app on the Android phone and complete **device
   verification**. This one cannot be done from a desktop.
4. Developer name "MaybeSitter" if allowed, otherwise the legal name. Public
   contact email = the support alias.
5. Setup → API access: **skip for now.** #182 creates the service account EAS
   Submit needs, after the first manual AAB upload.

## What Claude may and may not do here

May: keep this checklist accurate against the repository, prepare the store
metadata and declarations (#179), and reconcile them once the accounts exist.

May not, and has not: enrol, enter a card, handle a government ID, create an
account, or touch the owner's Apple or Google credentials.

## Status

`#158` stays **open**. It closes when both accounts are active and identity-
verified, which is a fact about two consoles and not about this repository.
