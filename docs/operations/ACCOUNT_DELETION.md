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
  It is also the deletion tombstone (#794): a uid's first request reads it before creating `users/{uid}`, and refuses with `403 deleted` when it exists, so a request that Firebase Auth admitted just before a deletion cannot re-create the account after the sweep. It is written before anything is destroyed and is never swept. Its 30-day TTL is far longer than the one-hour life of the ID token that race needs. Deleting it by hand reopens that race for a token still in flight.
  Its id depends on the pepper, so the pepper is rotated **only** by the two-phase runbook in `GCP_BOOTSTRAP.md`, "Rotating the deletion-receipt pepper" (#798): a request checks the job under every configured key before starting one, and the sweep finishes a job at the path it is stored at. A process that creates trust against shared Firestore without any pepper refuses (503) instead of guessing that nobody was deleted.
- Firestore point-in-time recovery covers the last 7 days. Say **within 30 days** publicly, to leave margin.
- Crashlytics reports are not linked to the account and roll off in 90 days.

## Handling an emailed request

1. **Check the sender.** The request must come from the address the account signs in with. An Apple private-relay address is fine — it is the address on the account.
2. **Find the uid.** Firebase console → Authentication, or `getAuth().getUserByEmail(...)`. Take the uid from there, never from the text of the ticket: the only identifier that can be trusted is the one the directory returns.
3. **Run the script** against the right environment. The block reads the pepper versions and the writer selector from the service itself, then fetches each version by number. So the shell holds exactly the keys the service holds, in every phase of a pepper rotation (#798, `GCP_BOOTSTRAP.md`). Never fetch the pepper by `latest`: once a rotation has created a new version, `latest` is a key that no live revision may read yet. A deletion under that key writes a tombstone that the service cannot see.

   ```sh
   (
     set -euo pipefail
     SVC=maybesitter-api-staging; DB=staging   # production: SVC=maybesitter-api; DB='(default)'
     DELETE_UID='<uid>'
     # The secret version the service mounts for a pepper variable: only ever
     # secretKeyRef.key, so a pepper set by mistake as a plain value is never read
     # (or printed) here. val() reads the one plain setting, the writer selector.
     ref() {
       gcloud run services describe "$SVC" --region=europe-west1 --format=json \
         | jq -r --arg n "$1" '.spec.template.spec.containers[0].env[] | select(.name == $n) | .valueFrom.secretKeyRef.key // empty'
     }
     val() {
       gcloud run services describe "$SVC" --region=europe-west1 --format=json \
         | jq -r --arg n "$1" '.spec.template.spec.containers[0].env[] | select(.name == $n) | .value // empty'
     }
     key() { gcloud secrets versions access "$1" --secret=maybesitter-deletion-receipt-pepper; }
     CUR="$(ref MAYBESITTER_DELETION_RECEIPT_PEPPER)"
     PREV="$(ref MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS)"
     WRITE="$(val MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE)"
     [ -n "$CUR" ] || { echo "the service mounts no pepper" >&2; exit 1; }
     echo "pepper version ${CUR}, previous ${PREV:-none}, write ${WRITE:-current}"
     export MAYBESITTER_STORAGE_BACKEND=firestore MAYBESITTER_FIRESTORE_DATABASE_ID="$DB"
     export MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE="${WRITE:-current}"
     MAYBESITTER_DELETION_RECEIPT_PEPPER="$(key "$CUR")"; export MAYBESITTER_DELETION_RECEIPT_PEPPER
     if [ -n "$PREV" ]; then
       MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS="$(key "$PREV")"; export MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS
     fi
     node --loader ./scripts/ts-resolver.mjs scripts/delete-account.ts "$DELETE_UID"
   )
   ```

   The subshell keeps the pepper out of your shell afterwards, and `set -e` stops the block before the script runs if any lookup fails. `CUR` is `latest` only while the service itself maps `latest`, which the runbook allows only before a rotation begins (its step 0 pins a number before step 1 creates a version). Be certain which project is configured first.

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

## A Google connect that raced the deletion (#800)

A Google connect can finish while its account is being deleted. The connect is then refused, and it takes back what it already holds: the stored credential, and the grant Google just issued. Account deletion's own revocation cannot see that grant, because no connection record was ever written. If either cleanup call fails, the obligation goes into `oauthCleanupObligations/{random id}`, outside the account's tree, so the deletion sweep cannot remove it. The grant is recorded the same way when another Google account was picked. When only the connection write failed, only the credential is recorded; the grant is left alone on purpose, because Google revokes the whole authorization for an account and that would also take back what the account already has connected. The nightly maintenance step `oauth_cleanups_retried` retries each obligation and deletes it once the cleanup lands. While one is still owed, the step reports `ok: false`. Google revokes the whole authorization for a Google account, so before each revoke the job checks whether any MaybeSitter account now holds a live connection to that Google account. A live connection is one that is not revoked or disconnected, still holds a credential, and belongs to an account that is not deleted or being deleted. If one exists, the job drops the obligation without revoking, because that holder's disconnect or account deletion will revoke the same authorization. A connection whose account is being deleted does not count: its deletion's own revoke may fail and its tree is then swept, so it would never revoke anything. The same check runs right after an obligation is written. A connect of that Google account also clears what is pending for it, as a shortcut; if that clear fails, the connect still succeeds and the check before revoking still protects it. One narrow window remains: the check, a re-read of the obligation and the revoke are three separate steps, because a call to Google cannot run inside a transaction. A connect of exactly that Google account that lands between the check and the revoke, during the nightly run, can still be taken back, and that connection then asks for a reconnect. Nothing about the account or the token is logged.

One case is older than #800 and is not fixed here: when a refused connect's immediate revoke succeeds, it can take back an authorization that another MaybeSitter account holds for the same Google account. That account's connection then needs a reconnect.

The document holds a kind (`credential_delete` or `grant_revoke`), a provider, timestamps and an attempt count. A revocation also holds `accountKey`, a peppered HMAC of the Google account id, which names nobody without the deletion pepper. The uid, the tokens, the Google account id and the fingerprint of the credential to delete are sealed with the vault's KMS key. The check before revoking uses the sealed account id, not `accountKey`, so rotating the pepper cannot weaken it; `accountKey` only serves the shortcut clear on connect, which looks under the current and the previous pepper. It has no TTL on purpose: if it expired, the cleanup would be dropped. **Do not delete one by hand** unless the grant is known to be revoked, for example after the person removed MaybeSitter at myaccount.google.com.

## What an operator must not do

- Do not delete documents by hand to "help it along". The engine's job record is what makes the deletion resumable and the receipt truthful; a manual delete leaves it inconsistent with both.
- Do not use the old `delete` trust action. It is retired: it deleted domain state only, left the sign-in account alive, and produced no receipt. It now answers `400 use_account_deletion`.
