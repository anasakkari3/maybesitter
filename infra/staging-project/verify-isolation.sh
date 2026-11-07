#!/usr/bin/env bash
# Read-only isolation gate for the staging project (Phase 5.8 §5).
#
# Checks, for every staging identity, what it CAN do in the staging project and
# what it CANNOT do in production (maybesitter-app), plus the Workload Identity
# trust and the IAM policies on both sides. It changes nothing: every call is a
# describe, a get-iam-policy, or `gcloud policy-troubleshoot iam`, which only
# evaluates policies. Any check that fails, or whose answer is not a clear
# GRANTED / NOT_GRANTED, fails the gate (exit 1). A staging deployment is not
# authorised until this exits 0.
#
# Usage:
#   infra/staging-project/verify-isolation.sh [--project-id ID] [--region REGION]
#
# Run it as the owner (it needs getIamPolicy on both projects). The Policy
# Troubleshooter calls are billed to the staging project (--billing-project),
# so no API is used, enabled or billed in production. Prompts are disabled,
# so gcloud can never offer to enable an API on the caller's behalf.
#
# Limits: the troubleshooter evaluates allow policies (with inheritance). The
# full-policy checks below cover what it cannot see by itself: unexpected
# members on the deploy identities and any staging identity in production's
# project policy.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${HERE}/common.sh"

PROJECT_ID="${STAGING_PROJECT_ID:-maybesitter-staging}"
REGION="europe-west1"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-id) PROJECT_ID="${2:?--project-id needs a value}"; shift 2 ;;
    --project-id=*) PROJECT_ID="${1#*=}"; shift ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --region=*) REGION="${1#*=}"; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
refuse_production_project "${PROJECT_ID}"
command -v gcloud >/dev/null 2>&1 || { echo "missing required tool: gcloud" >&2; exit 1; }
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROD="$(prod_project_id)"
PROD_NUMBER="$(prod_project_number)"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' --project "${PROJECT_ID}")"
refuse_production_project "${PROJECT_ID}" "${PROJECT_NUMBER}"

RUN_SA="$(sa_email "$(sa_run)" "${PROJECT_ID}")"
APP_SA="$(sa_email "$(sa_deploy_app)" "${PROJECT_ID}")"
INFRA_SA="$(sa_email "$(sa_deploy_infra)" "${PROJECT_ID}")"
SCHED_SA="$(sa_email "$(sa_scheduler)" "${PROJECT_ID}")"
STAGING_SAS=("${RUN_SA}" "${APP_SA}" "${INFRA_SA}" "${SCHED_SA}")
SERVICE="$(staging_service)"

# Full resource names.
S_PROJECT="//cloudresourcemanager.googleapis.com/projects/${PROJECT_ID}"
S_SERVICE="//run.googleapis.com/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE}"
S_REPO="//artifactregistry.googleapis.com/projects/${PROJECT_ID}/locations/${REGION}/repositories/$(staging_artifact_repo)"
s_sa() { printf '//iam.googleapis.com/projects/%s/serviceAccounts/%s' "${PROJECT_ID}" "$1"; }
s_secret() { printf '//secretmanager.googleapis.com/projects/%s/secrets/%s' "${PROJECT_NUMBER}" "$1"; }
P_PROJECT="//cloudresourcemanager.googleapis.com/projects/${PROD}"
P_SERVICE="//run.googleapis.com/projects/${PROD}/locations/europe-west1/services/maybesitter-api"
P_LEGACY_STAGING="//run.googleapis.com/projects/${PROD}/locations/europe-west1/services/maybesitter-api-staging"
p_sa() { printf '//iam.googleapis.com/projects/%s/serviceAccounts/%s@%s.iam.gserviceaccount.com' "${PROD}" "$1" "${PROD}"; }
p_secret() { printf '//secretmanager.googleapis.com/projects/%s/secrets/%s' "${PROD_NUMBER}" "$1"; }

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }

# access PRINCIPAL PERMISSION RESOURCE -> GRANTED | NOT_GRANTED | UNKNOWN_* | ERROR
access() {
  gcloud policy-troubleshoot iam "$3" --principal-email="$1" --permission="$2" \
    --billing-project="${PROJECT_ID}" --project "${PROJECT_ID}" --format='value(access)' 2>/dev/null || echo ERROR
}
can() { # principal permission resource
  local got
  got="$(access "$1" "$2" "$3")"
  if [ "${got}" = "GRANTED" ]; then pass "CAN    ${1%%@*} ${2} on ${3#//}"; else fail "CAN    ${1%%@*} ${2} on ${3#//} -> ${got:-empty}"; fi
}
cannot() { # principal permission resource
  local got
  got="$(access "$1" "$2" "$3")"
  if [ "${got}" = "NOT_GRANTED" ]; then pass "CANNOT ${1%%@*} ${2} on ${3#//}"; else fail "CANNOT ${1%%@*} ${2} on ${3#//} -> ${got:-empty}"; fi
}
# same NAME EXPECTED ACTUAL (exact string match)
same() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1"; printf '      expected: %s\n      actual:   %s\n' "$2" "$3"; fi
}
# members_of ROLE <gcloud get-iam-policy args...>: the sorted members bound to ROLE.
members_of() {
  local role="$1"
  shift
  gcloud "$@" --flatten='bindings[].members' --filter="bindings.role=${role}" \
    --format='value(bindings.members)' 2>/dev/null | sort
}
# roles_of <gcloud get-iam-policy args...>: the sorted distinct roles in a policy.
roles_of() {
  gcloud "$@" --flatten='bindings[]' --format='value(bindings.role)' 2>/dev/null | sort -u | paste -sd' ' -
}

echo "staging ${PROJECT_ID} (${PROJECT_NUMBER}) vs production ${PROD} (${PROD_NUMBER})"
echo

echo "## 1. CAN (staging project)"
can "${APP_SA}" run.services.get "${S_SERVICE}"
can "${APP_SA}" run.services.update "${S_SERVICE}"
can "${APP_SA}" artifactregistry.repositories.uploadArtifacts "${S_REPO}"
can "${APP_SA}" iam.serviceAccounts.actAs "$(s_sa "${RUN_SA}")"
can "${APP_SA}" datastore.indexes.list "${S_PROJECT}"
can "${INFRA_SA}" datastore.indexes.create "${S_PROJECT}"
can "${INFRA_SA}" firebaserules.releases.create "${S_PROJECT}"
can "${RUN_SA}" datastore.entities.get "${S_PROJECT}"
for secret in $(staging_secrets); do
  can "${RUN_SA}" secretmanager.versions.access "$(s_secret "${secret}")"
done
can "${SCHED_SA}" run.routes.invoke "${S_SERVICE}"

echo
echo "## 2. CANNOT inside staging (separation of duties)"
cannot "${APP_SA}" datastore.indexes.create "${S_PROJECT}"
cannot "${APP_SA}" firebaserules.releases.create "${S_PROJECT}"
cannot "${APP_SA}" run.services.setIamPolicy "${S_SERVICE}"
cannot "${APP_SA}" run.services.create "${S_PROJECT}"
cannot "${APP_SA}" iam.serviceAccounts.actAs "$(s_sa "${INFRA_SA}")"
cannot "${APP_SA}" iam.serviceAccounts.getAccessToken "$(s_sa "${INFRA_SA}")"
cannot "${APP_SA}" secretmanager.versions.access "$(s_secret maybesitter-deletion-receipt-pepper)"
cannot "${INFRA_SA}" run.services.update "${S_SERVICE}"
cannot "${INFRA_SA}" iam.serviceAccounts.actAs "$(s_sa "${RUN_SA}")"
cannot "${INFRA_SA}" secretmanager.versions.access "$(s_secret maybesitter-deletion-receipt-pepper)"
cannot "${RUN_SA}" run.services.update "${S_SERVICE}"
cannot "${RUN_SA}" iam.serviceAccounts.getAccessToken "$(s_sa "${APP_SA}")"

echo
echo "## 3. CANNOT in production (${PROD})"
for sa in "${STAGING_SAS[@]}"; do
  cannot "${sa}" run.services.update "${P_SERVICE}"
  cannot "${sa}" run.services.update "${P_LEGACY_STAGING}"
  cannot "${sa}" datastore.indexes.create "${P_PROJECT}"
  cannot "${sa}" firebaserules.releases.create "${P_PROJECT}"
  cannot "${sa}" datastore.entities.get "${P_PROJECT}"
  cannot "${sa}" firebaseauth.users.get "${P_PROJECT}"
  for secret in maybesitter-deletion-receipt-pepper maybesitter-llm-uid-salt maybesitter-football-data-api-key maybesitter-postpone-slot-hmac-key; do
    cannot "${sa}" secretmanager.versions.access "$(p_secret "${secret}")"
  done
  for target in maybesitter-run maybesitter-deployer; do
    cannot "${sa}" iam.serviceAccounts.getAccessToken "$(p_sa "${target}")"
    cannot "${sa}" iam.serviceAccounts.actAs "$(p_sa "${target}")"
  done
done

echo
echo "## 4. Production identities have nothing in staging"
for target in maybesitter-deployer maybesitter-run; do
  email="${target}@${PROD}.iam.gserviceaccount.com"
  cannot "${email}" run.services.update "${S_SERVICE}"
  cannot "${email}" datastore.entities.get "${S_PROJECT}"
  cannot "${email}" iam.serviceAccounts.getAccessToken "$(s_sa "${APP_SA}")"
done

echo
echo "## 5. Workload Identity trust"
for pair in "$(wif_pool_app)|$(wif_condition_app)|${APP_SA}" "$(wif_pool_infra)|$(wif_condition_infra)|${INFRA_SA}"; do
  pool="${pair%%|*}"
  rest="${pair#*|}"
  condition="${rest%|*}"
  sa="${rest##*|}"
  describe=(iam workload-identity-pools providers describe "$(wif_provider)" --workload-identity-pool="${pool}" --location=global --project "${PROJECT_ID}")
  same "${pool}: attribute condition" "${condition}" "$(gcloud "${describe[@]}" --format='value(attributeCondition)' 2>/dev/null || true)"
  same "${pool}: issuer" "https://token.actions.githubusercontent.com" "$(gcloud "${describe[@]}" --format='value(oidc.issuerUri)' 2>/dev/null || true)"
  same "${pool}: provider enabled" "ACTIVE" "$(gcloud "${describe[@]}" --format='value(state)' 2>/dev/null || true)"
  # The whole policy on each deploy identity: exactly one role, exactly one member.
  policy=(iam service-accounts get-iam-policy "${sa}" --project "${PROJECT_ID}")
  same "${sa%%@*}: only roles/iam.workloadIdentityUser is granted on it" "roles/iam.workloadIdentityUser" "$(roles_of "${policy[@]}")"
  same "${sa%%@*}: only its own pool may impersonate it" "$(wif_principal_set "${PROJECT_NUMBER}" "${pool}")" "$(members_of roles/iam.workloadIdentityUser "${policy[@]}" | paste -sd' ' -)"
done
policy=(iam service-accounts get-iam-policy "${RUN_SA}" --project "${PROJECT_ID}")
same "$(sa_run): only the app deployer may act as it" "roles/iam.serviceAccountUser" "$(roles_of "${policy[@]}")"
same "$(sa_run): actAs member" "serviceAccount:${APP_SA}" "$(members_of roles/iam.serviceAccountUser "${policy[@]}" | paste -sd' ' -)"
policy=(iam service-accounts get-iam-policy "${SCHED_SA}" --project "${PROJECT_ID}")
same "$(sa_scheduler): nobody may impersonate it" "" "$(roles_of "${policy[@]}")"

echo
echo "## 6. Project policies"
prod_members="$(gcloud projects get-iam-policy "${PROD}" --project "${PROD}" --flatten='bindings[].members' --format='value(bindings.members)' 2>/dev/null || echo ERROR)"
if [ "${prod_members}" = "ERROR" ]; then
  fail "read ${PROD} project policy"
elif printf '%s\n' "${prod_members}" | grep -q -e "@${PROJECT_ID}.iam.gserviceaccount.com" -e "projects/${PROJECT_NUMBER}/"; then
  fail "a staging identity appears in ${PROD}'s project policy"
  printf '%s\n' "${prod_members}" | grep -e "@${PROJECT_ID}.iam.gserviceaccount.com" -e "projects/${PROJECT_NUMBER}/" | sed 's/^/      /'
else
  pass "no staging identity in ${PROD}'s project policy"
fi
staging_members="$(gcloud projects get-iam-policy "${PROJECT_ID}" --project "${PROJECT_ID}" --flatten='bindings[].members' --format='value(bindings.members)' 2>/dev/null || echo ERROR)"
if [ "${staging_members}" = "ERROR" ]; then
  fail "read ${PROJECT_ID} project policy"
elif printf '%s\n' "${staging_members}" | grep -q -e "@${PROD}.iam.gserviceaccount.com" -e "projects/${PROD_NUMBER}/" -e "${PROD_NUMBER}-compute@"; then
  fail "a production identity appears in ${PROJECT_ID}'s project policy"
else
  pass "no production identity in ${PROJECT_ID}'s project policy"
fi
# The deploy workflows rely on the service already being public; the app
# deployer cannot make it so (section 2).
same "${SERVICE}: allUsers may invoke (the app authenticates every request)" "allUsers" \
  "$(members_of roles/run.invoker run services get-iam-policy "${SERVICE}" --region="${REGION}" --project "${PROJECT_ID}" | grep -x allUsers || true)"
same "${SERVICE}: runs as $(sa_run)" "${RUN_SA}" \
  "$(gcloud run services describe "${SERVICE}" --region="${REGION}" --project "${PROJECT_ID}" --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)"

echo
echo "passed ${PASS}, failed ${FAIL}"
if [ "${FAIL}" -ne 0 ]; then
  echo "ISOLATION GATE: FAIL. Do not deploy to staging." >&2
  exit 1
fi
echo "ISOLATION GATE: PASS"
