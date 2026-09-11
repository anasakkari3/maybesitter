#!/usr/bin/env bash
# Verify the MaybeSitter cloud project matches what infra/bootstrap.sh creates
# (UC-1.0a, #140). Prints one line per check and exits non-zero if any failed,
# so it can gate a deploy.
#
# Usage: infra/verify.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-maybesitter-app}"
REGION="${REGION:-europe-west1}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-anasakkari3/maybesitter}"
SECRET_NAME="maybesitter-deletion-receipt-pepper"

RUN_SA="maybesitter-run@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA="maybesitter-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="maybesitter-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

fails=0
ok()  { printf 'OK   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { # description, condition-as-command
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "${desc}"; else bad "${desc}"; fi
}

command -v gcloud >/dev/null 2>&1 || { echo "missing required tool: gcloud" >&2; exit 1; }

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

# --- APIs -------------------------------------------------------------------
gcloud services list --enabled --project "${PROJECT_ID}" --format='value(config.name)' >"${workdir}/apis.txt"
for api in firebase firestore run artifactregistry cloudbuild secretmanager \
           cloudscheduler fcm identitytoolkit aiplatform iam iamcredentials \
           sts firebaserules; do
  if grep -qx "${api}.googleapis.com" "${workdir}/apis.txt"; then
    ok "api ${api}"
  else
    bad "api ${api} not enabled"
  fi
done

# --- Firestore --------------------------------------------------------------
# Same list as infra/bootstrap.sh; tests/storage/firestoreDatabases.test.ts
# checks the two agree with firebase.json and infra/cloudrun/flags.sh.
FIRESTORE_DATABASES=('(default)' 'staging')
for database in "${FIRESTORE_DATABASES[@]}"; do
  if gcloud firestore databases describe --database="${database}" --project "${PROJECT_ID}" \
      --format=json >"${workdir}/db.json" 2>/dev/null; then
    ok "firestore ${database} exists"
    for pair in \
      "\"locationId\": \"${REGION}\"|firestore ${database} in ${REGION}" \
      '"type": "FIRESTORE_NATIVE"|firestore '"${database}"' in native mode' \
      '"pointInTimeRecoveryEnablement": "POINT_IN_TIME_RECOVERY_ENABLED"|firestore '"${database}"' PITR enabled' \
      '"deleteProtectionState": "DELETE_PROTECTION_ENABLED"|firestore '"${database}"' delete protection on'; do
      needle="${pair%%|*}"
      desc="${pair##*|}"
      if grep -q "${needle}" "${workdir}/db.json"; then ok "${desc}"; else bad "${desc}"; fi
    done
  else
    bad "firestore ${database} missing"
  fi
done

# --- Service accounts, and no user-managed keys anywhere --------------------
gcloud projects get-iam-policy "${PROJECT_ID}" --format=json >"${workdir}/policy.json"
for sa in "${RUN_SA}" "${DEPLOYER_SA}" "${SCHEDULER_SA}"; do
  short="${sa%%@*}"
  if ! gcloud iam service-accounts describe "${sa}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    bad "sa ${short} missing"
    continue
  fi
  ok "sa ${short} exists"

  keys="$(gcloud iam service-accounts keys list --managed-by=user --iam-account="${sa}" \
    --project "${PROJECT_ID}" --format='value(name)' 2>/dev/null || true)"
  if [ -z "${keys}" ]; then
    ok "sa ${short} has no user-managed keys"
  else
    bad "sa ${short} has user-managed keys — delete them, deploys use WIF"
  fi

  # No project-wide owner or editor on any of our service accounts.
  if python3 -c '
import json, sys
policy = json.load(open(sys.argv[1]))
member = "serviceAccount:" + sys.argv[2]
wide = [b["role"] for b in policy.get("bindings", [])
        if b["role"] in ("roles/owner", "roles/editor") and member in b.get("members", [])]
sys.exit(1 if wide else 0)
' "${workdir}/policy.json" "${sa}"; then
    ok "sa ${short} has no owner/editor role"
  else
    bad "sa ${short} holds owner or editor"
  fi
done

# --- Workload Identity Federation -------------------------------------------
if gcloud iam workload-identity-pools providers describe github-actions \
    --workload-identity-pool=github --location=global --project "${PROJECT_ID}" \
    --format=json >"${workdir}/wif.json" 2>/dev/null; then
  ok "wif provider exists"
  if grep -q 'token.actions.githubusercontent.com' "${workdir}/wif.json"; then
    ok "wif issuer is GitHub"
  else
    bad "wif issuer is not GitHub"
  fi
  if grep -q "assertion.repository=='${GITHUB_REPOSITORY}'" "${workdir}/wif.json"; then
    ok "wif restricted to ${GITHUB_REPOSITORY}"
  else
    bad "wif condition does not pin the repository"
  fi
  if grep -q "assertion.ref=='refs/heads/main'" "${workdir}/wif.json"; then
    ok "wif restricted to refs/heads/main"
  else
    bad "wif condition does not pin the branch"
  fi
else
  bad "wif provider missing"
fi

# --- Secret container -------------------------------------------------------
check "secret ${SECRET_NAME} exists" \
  gcloud secrets describe "${SECRET_NAME}" --project "${PROJECT_ID}"

if [ "${fails}" -eq 0 ]; then
  printf '\nverify: all checks passed\n'
  exit 0
fi
printf '\nverify: %d check(s) failed\n' "${fails}"
exit 1
