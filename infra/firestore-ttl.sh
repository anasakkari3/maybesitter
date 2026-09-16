#!/usr/bin/env bash
#
# Firestore TTL policies (UC-1.0c, #142).
#
# These collections hold data with a retention limit rather than a lifetime:
#
#   alphaTraces       30 days  - raw capture text captured for alpha review
#   clarifications    24 hours - a half-finished question, worthless once stale
#   analyticsEvents   400 days - product metrics
#   captureProposals  24 hours - a proposal awaiting confirmation (#252)
#   deletionReceipts  400 days - proof a deletion happened, naming nobody (#149)
#   accountDeletions  30 days  - the deletion job, kept only so a repeat request
#                                is idempotent; it holds no uid once done (#149)
#   hardReminders      2 days  - one Must reminder the server may have to back
#                                up: ids and instants, no title (#198)
#
# Retention is enforced by Firestore rather than by a cron job we have to keep
# alive: each document is written with an `expiresAt` timestamp and the TTL
# policy deletes it. A prune script that stops running fails silently and the
# data simply stays; a TTL policy that is not configured fails visibly here.
#
# The window is set at *write* time, in the store that writes the document, so
# the retention of a record is decided by the code that created it. This script
# only tells Firestore which field to read.
#
# Run once per environment, and again whenever a collection is added. It is
# idempotent: enabling a TTL that is already enabled is not an error.
#
# Usage:
#   infra/firestore-ttl.sh [--project PROJECT_ID] [--database DATABASE] [--dry-run]
#
# Verify afterwards with:
#   gcloud firestore fields ttls list --project=PROJECT_ID
set -euo pipefail

PROJECT="${MAYBESITTER_GCP_PROJECT:-${GOOGLE_CLOUD_PROJECT:-maybesitter-app}}"
DATABASE="${MAYBESITTER_FIRESTORE_DATABASE:-(default)}"
DRY_RUN=false

# The field every TTL-bearing document carries. It must be a timestamp: a
# policy on a string field is accepted and then never deletes anything, which
# is why the stores write a Date rather than an ISO string.
TTL_FIELD="expiresAt"

# Collection groups with a retention limit. Keep in step with
# docs/architecture/firestore-data-model.md, which records the window for each.
COLLECTION_GROUPS=(
  "alphaTraces"
  "clarifications"
  "analyticsEvents"
  "captureProposals"
  # UC-1.5 (#149): the proof a deletion happened, and the job that ran it.
  # Both are top-level and outlive the account, so nothing else would ever
  # remove them.
  "deletionReceipts"
  "accountDeletions"
  # UC-3.12b (#198): the Must-reminder index. A row is written with `expiresAt`
  # two days past the reminder it describes; after that it is a record of a
  # notification nobody can act on.
  "hardReminders"
)

usage() {
  sed -n '2,26p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      [ "$#" -ge 2 ] || { echo "--project needs a value" >&2; exit 2; }
      PROJECT="$2"
      shift 2
      ;;
    --database)
      [ "$#" -ge 2 ] || { echo "--database needs a value" >&2; exit 2; }
      DATABASE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v gcloud > /dev/null 2>&1; then
  echo "gcloud is not installed or not on PATH" >&2
  exit 1
fi

echo "Enabling Firestore TTL on '${TTL_FIELD}'"
echo "  project:  ${PROJECT}"
echo "  database: ${DATABASE}"
echo

for group in "${COLLECTION_GROUPS[@]}"; do
  echo "→ ${group}"
  if [ "$DRY_RUN" = true ]; then
    echo "  (dry run) gcloud firestore fields ttls update ${TTL_FIELD}" \
      "--collection-group=${group} --enable-ttl --project=${PROJECT} --database=${DATABASE}"
    continue
  fi

  # `--async` is deliberately not used: a TTL build can take time on a large
  # collection, and a script that returns before the policy exists would let a
  # deploy report retention as configured when it is still pending.
  gcloud firestore fields ttls update "${TTL_FIELD}" \
    --collection-group="${group}" \
    --enable-ttl \
    --project="${PROJECT}" \
    --database="${DATABASE}" \
    --quiet
done

echo
echo "Done. Confirm with:"
echo "  gcloud firestore fields ttls list --project=${PROJECT} --database=${DATABASE}"
