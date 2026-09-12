# Account deletion (UC-1.5, #149)

Most deletions never reach an operator: the app has **Settings → Account → Delete account**, and that calls `DELETE /api/mobile/account`. This runbook is for the rest — someone who uninstalled the app first, or emailed support.

Both paths run the same code (`lib/account/accountDeletion.ts`). There is deliberately no second implementation for operators: the one that drifts would be the one a user is told about.

## What deletion removes

| Removed | Where |
|---|---|
| Every commitment, reminder, event, capture proposal, consent record, analytics event | `users/{uid}/**` |
| Scheduled work for the account | `jobs` where `uid == <uid>` |
| Trust incidents about the account | `incidents` where `participantId == <uid>` |
| The sign-in account itself | Firebase Auth |
| External grants (calendar and similar) | whatever is registered in `lib/account/deletionHooks.ts` |

What is kept, and why:

- **The receipt** (`deletionReceipts/{receiptId}`, 400 days). It contains no uid, email, name or content — the subject is `HMAC-SHA256(pepper, uid)`. It exists so "prove you deleted me" has an answer.
- **The job record** (`accountDeletions/{subjectHash}`, 30 days), which makes a repeat request idempotent. Its `uid` field is removed the moment the deletion completes.
- Firestore point-in-time recovery covers the last 7 days. Say **within 30 days** publicly, to leave margin.
- Crashlytics reports are not linked to the account and roll off in 90 days.

## Handling an emailed request

1. **Check the sender.** The request must come from the address the account signs in with. An Apple private-relay address is fine — it is the address on the account.
2. **Find the uid.** Firebase console → Authentication, or `getAuth().getUserByEmail(...)`. Take the uid from there, never from the text of the ticket: the only identifier that can be trusted is the one the directory returns.
3. **Run the script** against the right environment:

   ```sh
   MAYBESITTER_STORAGE_BACKEND=firestore \
   MAYBESITTER_FIRESTORE_DATABASE_ID=staging \
   MAYBESITTER_DELETION_RECEIPT_PEPPER="$(gcloud secrets versions access latest --secret=maybesitter-deletion-receipt-pepper)" \
     node --loader ./scripts/ts-resolver.mjs scripts/delete-account.ts <uid>
   ```

   For production, drop `MAYBESITTER_FIRESTORE_DATABASE_ID` so it uses `(default)`, and be certain which project is configured first.

   Never echo the pepper, never paste it into a ticket, and never store it outside Secret Manager.

4. **Reply with the receipt id**, within 30 days of the request.
5. **Record only the receipt id** in the ticket. Not the uid, not the subject hash, not what was deleted.

The script exits non-zero if any step reported `failed`. The account is still deleted in that case — a failure here means an *external* revocation did not land, and it needs chasing separately.

## If a deletion gets stuck

A deletion whose process died is finished by the nightly maintenance sweep (`deletions_resumed` in `POST /api/internal/jobs/maintenance`), which picks up jobs left `in_progress` for more than 10 minutes.

After 5 attempts the job is marked `stuck` and logged:

```
[account/delete] deletion_stuck subject=<12 hex chars> attempts=5 steps={…}
```

That log line carries the subject tag and the step outcomes and nothing else, which is enough to find the job:

```sh
gcloud firestore documents list accountDeletions --database=staging   # or query status == 'stuck'
```

The steps say what is left. Re-running the script for the same uid resumes the job rather than starting a second one — every step checks before it acts, and the receipt is written once.

## What an operator must not do

- Do not delete documents by hand to "help it along". The engine's job record is what makes the deletion resumable and the receipt truthful; a manual delete leaves it inconsistent with both.
- Do not use the old `delete` trust action. It is retired: it deleted domain state only, left the sign-in account alive, and produced no receipt. It now answers `400 use_account_deletion`.
