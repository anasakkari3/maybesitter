#!/usr/bin/env bash
# Bootstrap the isolated staging GCP + Firebase project (Phase 5.8, Option A).
#
# Staging gets its own project, so no staging identity holds any grant in the
# production project (maybesitter-app) and no production identity holds one
# here. Nothing in this script reads, copies or changes anything in production.
#
# SAFE BY DEFAULT: without --apply it only prints the commands it would run and
# calls nothing at all (no gcloud, no firebase, no network). With --apply it is
# idempotent: every create is guarded by a describe, and secret values are
# generated only for a secret that has no version yet, so a re-run never
# rotates them.
#
# Every gcloud call goes through gc(), which refuses a call that does not name
# this staging project with --project, and refuses any other project. The
# gcloud default project (`gcloud config get project`) is never relied on.
#
# Usage:
#   infra/staging-project/bootstrap.sh                      # dry run (default)
#   infra/staging-project/bootstrap.sh --apply \
#       --billing-account 0X0X0X-0X0X0X-0X0X0X [--budget 5USD] [--with-kms]
#
# Options:
#   --project-id ID        staging project id (default: $STAGING_PROJECT_ID or maybesitter-staging)
#   --region REGION        default europe-west1 (Firestore's location is permanent)
#   --billing-account ID   link this billing account. Without it, billing is
#                          never touched, and an --apply run stops after
#                          creating the project if billing is not enabled.
#   --budget AMOUNT        optional budget alert on this project, e.g. 5USD (the
#                          currency must be the billing account's own). Needs
#                          --billing-account.
#   --with-kms             create the `user-secrets` KMS key flags.sh names
#                          (Google connect and calendar links need it; ~$0.06/month)
#   --dry-run              print only (the default)
#   --apply                execute
#
# See infra/staging-project/README.md for the runbook and teardown.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${HERE}/common.sh"

PROJECT_ID="${STAGING_PROJECT_ID:-maybesitter-staging}"
REGION="europe-west1"
BILLING_ACCOUNT=""
BUDGET=""
WITH_KMS=0
APPLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-id) PROJECT_ID="${2:?--project-id needs a value}"; shift 2 ;;
    --project-id=*) PROJECT_ID="${1#*=}"; shift ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --region=*) REGION="${1#*=}"; shift ;;
    --billing-account) BILLING_ACCOUNT="${2:?--billing-account needs a value}"; shift 2 ;;
    --billing-account=*) BILLING_ACCOUNT="${1#*=}"; shift ;;
    --budget) BUDGET="${2:?--budget needs a value, e.g. 5USD}"; shift 2 ;;
    --budget=*) BUDGET="${1#*=}"; shift ;;
    --with-kms) WITH_KMS=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --apply) APPLY=1; shift ;;
    -h | --help) sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

refuse_production_project "${PROJECT_ID}"
if [ -n "${BUDGET}" ] && [ -z "${BILLING_ACCOUNT}" ]; then
  echo "REFUSED: --budget needs --billing-account" >&2
  exit 2
fi
case "${BUDGET}" in '' | [0-9]*[A-Z][A-Z][A-Z]) ;; *) echo "REFUSED: --budget must look like 5USD" >&2; exit 2 ;; esac

RUN_SA="$(sa_email "$(sa_run)" "${PROJECT_ID}")"
DEPLOY_APP_SA="$(sa_email "$(sa_deploy_app)" "${PROJECT_ID}")"
DEPLOY_INFRA_SA="$(sa_email "$(sa_deploy_infra)" "${PROJECT_ID}")"
SCHEDULER_SA="$(sa_email "$(sa_scheduler)" "${PROJECT_ID}")"
SERVICE="$(staging_service)"
ARTIFACT_REPO="$(staging_artifact_repo)"
DATABASE="$(staging_database)"
PROJECT_NUMBER="<PROJECT_NUMBER>"

say() { printf '\n=== %s\n' "$1"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }

# gc ARGS...: the only way this script calls gcloud. It requires --project and
# requires it to be this staging project. In a dry run it prints the command.
gc() {
  local arg next=0 seen=""
  for arg in "$@"; do
    if [ "${next}" = 1 ]; then seen="${arg}"; next=0; continue; fi
    case "${arg}" in
      --project) next=1 ;;
      --project=*) seen="${arg#--project=}" ;;
    esac
  done
  if [ -z "${seen}" ]; then
    echo "REFUSED (bug): gcloud $* has no explicit --project" >&2
    exit 4
  fi
  if [ "${seen}" != "${PROJECT_ID}" ]; then
    echo "REFUSED (bug): gcloud call names project ${seen}, not ${PROJECT_ID}" >&2
    exit 4
  fi
  if [ "${APPLY}" = 1 ]; then
    gcloud "$@"
  else
    # stderr, so a call whose stdout the script discards is still shown.
    { printf '  '; printf '%q ' gcloud "$@"; printf '\n'; } >&2
  fi
}

# probe ARGS...: a read-only gcloud describe/list. Runs only with --apply; in a
# dry run it reports "absent", so the plan shows every create.
probe() {
  if [ "${APPLY}" = 1 ]; then
    gc "$@" >/dev/null 2>&1
  else
    return 1
  fi
}

# probe_out ARGS...: like probe, but prints the command's output.
probe_out() {
  if [ "${APPLY}" = 1 ]; then
    gc "$@" 2>/dev/null
  fi
}

if [ "${APPLY}" = 1 ]; then
  need gcloud
  need firebase
  need openssl
  # No prompt may silently answer for us (e.g. "enable this API on <project>?").
  export CLOUDSDK_CORE_DISABLE_PROMPTS=1
  echo "APPLY mode: creating resources in ${PROJECT_ID} only."
else
  echo "DRY RUN: printing the commands only. Nothing is called. Re-run with --apply to execute."
fi

# ── Project ────────────────────────────────────────────────────────────────
say "project ${PROJECT_ID}"
if probe projects describe "${PROJECT_ID}" --project "${PROJECT_ID}"; then
  echo "  exists"
else
  gc projects create "${PROJECT_ID}" --name="MaybeSitter Staging" --project "${PROJECT_ID}"
fi
if [ "${APPLY}" = 1 ]; then
  PROJECT_NUMBER="$(gc projects describe "${PROJECT_ID}" --format='value(projectNumber)' --project "${PROJECT_ID}")"
  STATE="$(gc projects describe "${PROJECT_ID}" --format='value(lifecycleState)' --project "${PROJECT_ID}")"
  refuse_production_project "${PROJECT_ID}" "${PROJECT_NUMBER}"
  [ "${STATE}" = "ACTIVE" ] || { echo "REFUSED: ${PROJECT_ID} is ${STATE}, not ACTIVE" >&2; exit 3; }
  echo "  project number ${PROJECT_NUMBER}"
fi

# ── Billing (only with an explicit --billing-account) ──────────────────────
say "billing"
if [ -n "${BILLING_ACCOUNT}" ]; then
  gc billing projects link "${PROJECT_ID}" --billing-account="${BILLING_ACCOUNT}" --project "${PROJECT_ID}"
else
  echo "  no --billing-account given: billing is not touched"
fi
if [ "${APPLY}" = 1 ]; then
  BILLING_ENABLED="$(probe_out billing projects describe "${PROJECT_ID}" --format='value(billingEnabled)' --project "${PROJECT_ID}" || true)"
  if [ "${BILLING_ENABLED}" != "True" ]; then
    cat >&2 <<EOF
STOP: billing is not enabled on ${PROJECT_ID}. Cloud Run, Artifact Registry,
Secret Manager and Firestore cannot be enabled without it. The project exists
and costs nothing as it is. Re-run with --billing-account <id> once the owner
has approved billing, or delete it: gcloud projects delete ${PROJECT_ID}
EOF
    exit 5
  fi
fi

if [ -n "${BUDGET}" ]; then
  say "budget alert ${BUDGET}/month (alerts only; a budget never caps spend)"
  BUDGET_NAME="${PROJECT_ID}-monthly"
  if [ -n "$(probe_out billing budgets list --billing-account="${BILLING_ACCOUNT}" \
      --filter="displayName=${BUDGET_NAME}" --format='value(name)' \
      --billing-project="${PROJECT_ID}" --project "${PROJECT_ID}")" ]; then
    echo "  exists"
  else
    gc billing budgets create --billing-account="${BILLING_ACCOUNT}" \
      --display-name="${BUDGET_NAME}" --budget-amount="${BUDGET}" \
      --filter-projects="projects/${PROJECT_ID}" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
      --billing-project="${PROJECT_ID}" --project "${PROJECT_ID}"
  fi
fi

# ── APIs: only what staging uses ───────────────────────────────────────────
# firebaserules: infra-staging.yml deploys rules. policytroubleshooter:
# verify-isolation.sh bills its checks to this project, never to production.
# Not enabled on purpose: aiplatform (staging runs with the model off,
# MAYBESITTER_AI_DISABLED=true, so it cannot spend), cloudbuild (images are
# built on the GitHub runner).
say "APIs"
APIS=(
  run.googleapis.com
  firestore.googleapis.com
  firebase.googleapis.com
  firebaserules.googleapis.com
  artifactregistry.googleapis.com
  secretmanager.googleapis.com
  cloudscheduler.googleapis.com
  iamcredentials.googleapis.com
  iam.googleapis.com
  sts.googleapis.com
  serviceusage.googleapis.com
  identitytoolkit.googleapis.com
  logging.googleapis.com
  monitoring.googleapis.com
  billingbudgets.googleapis.com
  policytroubleshooter.googleapis.com
)
if [ "${WITH_KMS}" = 1 ]; then APIS+=(cloudkms.googleapis.com); fi
gc services enable "${APIS[@]}" --project "${PROJECT_ID}"

# ── Firebase ───────────────────────────────────────────────────────────────
say "Firebase"
if [ "${APPLY}" = 1 ]; then
  if firebase projects:list --json 2>/dev/null | grep -q "\"${PROJECT_ID}\""; then
    echo "  already a Firebase project"
  else
    firebase projects:addfirebase "${PROJECT_ID}"
  fi
else
  { printf '  '; printf '%q ' firebase projects:addfirebase "${PROJECT_ID}"; printf '\n'; } >&2
fi

# ── Firestore ──────────────────────────────────────────────────────────────
say "Firestore database ${DATABASE} in ${REGION}"
if probe firestore databases describe --database="${DATABASE}" --project "${PROJECT_ID}"; then
  echo "  exists"
else
  # No point-in-time recovery: staging holds synthetic data only, and PITR
  # bills retained versions. Delete protection is free; `projects delete`
  # still removes it on teardown.
  gc firestore databases create --database="${DATABASE}" --location="${REGION}" \
    --type=firestore-native --delete-protection --project "${PROJECT_ID}"
fi

# ── Artifact Registry ──────────────────────────────────────────────────────
say "Artifact Registry ${ARTIFACT_REPO}"
if probe artifacts repositories describe "${ARTIFACT_REPO}" --location="${REGION}" --project "${PROJECT_ID}"; then
  echo "  exists"
else
  gc artifacts repositories create "${ARTIFACT_REPO}" --repository-format=docker \
    --location="${REGION}" --description="MaybeSitter staging images" --project "${PROJECT_ID}"
fi
gc artifacts repositories set-cleanup-policies "${ARTIFACT_REPO}" --location="${REGION}" \
  --policy="${HERE}/../artifact-cleanup.json" --no-dry-run --project "${PROJECT_ID}"

# ── Service accounts ───────────────────────────────────────────────────────
say "service accounts"
create_sa() { # account id, display name
  if probe iam service-accounts describe "$(sa_email "$1" "${PROJECT_ID}")" --project "${PROJECT_ID}"; then
    echo "  $1 exists"
  else
    gc iam service-accounts create "$1" --display-name="$2" --project "${PROJECT_ID}"
  fi
}
create_sa "$(sa_run)" "Staging Cloud Run runtime"
create_sa "$(sa_deploy_app)" "Staging app deployer (deploy-staging.yml via WIF)"
create_sa "$(sa_deploy_infra)" "Staging infra deployer (infra-staging.yml via WIF)"
create_sa "$(sa_scheduler)" "Staging Cloud Scheduler OIDC identity"

# ── Project-level roles, inside the staging project only ───────────────────
# Firestore and Firebase Rules administration exist only at project level,
# which is exactly why staging needs its own project.
say "project roles (staging project only)"
add_role() { gc projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:$1" --role="$2" --condition=None --project "${PROJECT_ID}" >/dev/null; }
add_role "${RUN_SA}" roles/datastore.user
add_role "${RUN_SA}" roles/firebaseauth.admin
add_role "${DEPLOY_INFRA_SA}" roles/datastore.indexAdmin
add_role "${DEPLOY_INFRA_SA}" roles/firebaserules.admin
# firebase-tools checks the Firestore API is enabled before deploying and does
# not catch a 403 there (same reason as infra/bootstrap.sh).
add_role "${DEPLOY_INFRA_SA}" roles/serviceusage.serviceUsageConsumer
# Read-only: deploy-staging.yml checks the indexes are READY. It never creates one.
add_role "${DEPLOY_APP_SA}" roles/datastore.indexViewer

# ── Resource-level grants ──────────────────────────────────────────────────
say "Artifact Registry writer: the app deployer, on this one repository"
gc artifacts repositories add-iam-policy-binding "${ARTIFACT_REPO}" --location="${REGION}" \
  --member="serviceAccount:${DEPLOY_APP_SA}" --role=roles/artifactregistry.writer --project "${PROJECT_ID}" >/dev/null

say "actAs: the app deployer may deploy as ${RUN_SA} and as no other identity"
gc iam service-accounts add-iam-policy-binding "${RUN_SA}" \
  --member="serviceAccount:${DEPLOY_APP_SA}" --role=roles/iam.serviceAccountUser --project "${PROJECT_ID}" >/dev/null

# ── Secrets: NEW values, generated here, never copied from production ──────
say "secrets"
for secret in $(staging_secrets); do
  if probe secrets describe "${secret}" --project "${PROJECT_ID}"; then
    echo "  ${secret} exists"
  else
    gc secrets create "${secret}" --replication-policy=user-managed --locations="${REGION}" --project "${PROJECT_ID}"
  fi
  existing=""
  if [ "${APPLY}" = 1 ]; then
    existing="$(probe_out secrets versions list "${secret}" --filter='state=ENABLED' --limit=1 \
      --format='value(name)' --project "${PROJECT_ID}" || true)"
  fi
  if [ -n "${existing}" ]; then
    echo "  ${secret} already has a value; left unchanged (no rotation on re-run)"
  elif [ "${secret}" = "maybesitter-football-data-api-key" ]; then
    # Placeholder, deliberately whitespace: footballProviderConfigured()
    # (lib/football/footballWatchers.ts) trims the key, so the app reports the
    # provider as not configured and never calls football-data.org. Replace
    # it only with a separate staging key, never production's.
    if [ "${APPLY}" = 1 ]; then
      printf ' ' | gc secrets versions add "${secret}" --data-file=- --project "${PROJECT_ID}" >/dev/null
    else
      printf >&2 "  printf ' ' | gcloud secrets versions add %s --data-file=- --project %s   # placeholder: football disabled\n" "${secret}" "${PROJECT_ID}"
    fi
  else
    # 32 random bytes, hex. Piped straight into Secret Manager: the value is
    # never printed, logged or written to disk.
    if [ "${APPLY}" = 1 ]; then
      openssl rand -hex 32 | tr -d '\n' | gc secrets versions add "${secret}" --data-file=- --project "${PROJECT_ID}" >/dev/null
    else
      printf >&2 "  openssl rand -hex 32 | tr -d '\\\\n' | gcloud secrets versions add %s --data-file=- --project %s\n" "${secret}" "${PROJECT_ID}"
    fi
  fi
  gc secrets add-iam-policy-binding "${secret}" --member="serviceAccount:${RUN_SA}" \
    --role=roles/secretmanager.secretAccessor --project "${PROJECT_ID}" >/dev/null
done

# ── Optional KMS key (the name infra/cloudrun/flags.sh derives) ───────────
if [ "${WITH_KMS}" = 1 ]; then
  say "KMS key maybesitter/user-secrets"
  if probe kms keyrings describe maybesitter --location="${REGION}" --project "${PROJECT_ID}"; then
    echo "  keyring exists"
  else
    gc kms keyrings create maybesitter --location="${REGION}" --project "${PROJECT_ID}"
  fi
  if probe kms keys describe user-secrets --keyring=maybesitter --location="${REGION}" --project "${PROJECT_ID}"; then
    echo "  key exists"
  else
    gc kms keys create user-secrets --keyring=maybesitter --location="${REGION}" --purpose=encryption --project "${PROJECT_ID}"
  fi
  gc kms keys add-iam-policy-binding user-secrets --keyring=maybesitter --location="${REGION}" \
    --member="serviceAccount:${RUN_SA}" --role=roles/cloudkms.cryptoKeyEncrypterDecrypter --project "${PROJECT_ID}" >/dev/null
else
  say "KMS: skipped (no --with-kms). Google connect and calendar links answer not_configured on staging."
fi

# ── Workload Identity Federation: one pool per workflow ────────────────────
ensure_pool() { # pool id, display name, condition, service account
  local pool="$1" display="$2" condition="$3" sa="$4"
  say "WIF pool ${pool} -> ${sa}"
  if probe iam workload-identity-pools describe "${pool}" --location=global --project "${PROJECT_ID}"; then
    echo "  pool exists"
  else
    gc iam workload-identity-pools create "${pool}" --location=global --display-name="${display}" --project "${PROJECT_ID}"
  fi
  if probe iam workload-identity-pools providers describe "$(wif_provider)" \
      --workload-identity-pool="${pool}" --location=global --project "${PROJECT_ID}"; then
    # Re-asserted on every run, so a hand edit in the console is undone.
    gc iam workload-identity-pools providers update-oidc "$(wif_provider)" \
      --workload-identity-pool="${pool}" --location=global \
      --attribute-mapping="$(wif_attribute_mapping)" --attribute-condition="${condition}" --project "${PROJECT_ID}"
  else
    gc iam workload-identity-pools providers create-oidc "$(wif_provider)" \
      --workload-identity-pool="${pool}" --location=global \
      --issuer-uri="https://token.actions.githubusercontent.com" \
      --attribute-mapping="$(wif_attribute_mapping)" --attribute-condition="${condition}" --project "${PROJECT_ID}"
  fi
  gc iam service-accounts add-iam-policy-binding "${sa}" --role=roles/iam.workloadIdentityUser \
    --member="$(wif_principal_set "${PROJECT_NUMBER}" "${pool}")" --project "${PROJECT_ID}" >/dev/null
}
ensure_pool "$(wif_pool_app)" "GitHub deploy-staging.yml" "$(wif_condition_app)" "${DEPLOY_APP_SA}"
ensure_pool "$(wif_pool_infra)" "GitHub infra-staging.yml" "$(wif_condition_infra)" "${DEPLOY_INFRA_SA}"

# ── Cloud Run service (placeholder) and its resource-level grants ─────────
# The app deployer gets run.developer on this one service, not on the project.
# A resource-level grant needs the resource, so the operator creates the
# service once with Google's public sample image, scaled to zero. The first
# deploy-staging.yml run replaces it behind a tag.
#
# The service is public (allUsers invoker), as production is: the app checks
# a Firebase ID token on every request itself. The operator sets that binding
# here, once, so the app deployer never needs run.services.setIamPolicy
# (run.admin); deploy-staging.yml leaves --allow-unauthenticated out.
say "Cloud Run ${SERVICE}"
if probe run services describe "${SERVICE}" --region="${REGION}" --project "${PROJECT_ID}"; then
  echo "  exists"
else
  gc run deploy "${SERVICE}" --image=us-docker.pkg.dev/cloudrun/container/hello \
    --region="${REGION}" --service-account="${RUN_SA}" --no-allow-unauthenticated \
    --min-instances=0 --max-instances=1 --project "${PROJECT_ID}"
fi
svc_role() { gc run services add-iam-policy-binding "${SERVICE}" --region="${REGION}" \
  --member="$1" --role="$2" --project "${PROJECT_ID}" >/dev/null; }
svc_role allUsers roles/run.invoker
svc_role "serviceAccount:${DEPLOY_APP_SA}" roles/run.developer
svc_role "serviceAccount:${SCHEDULER_SA}" roles/run.invoker

DONE_NOTE="applied"
[ "${APPLY}" = 1 ] || DONE_NOTE="DRY RUN: nothing was created"
cat <<EOF

=== done (${DONE_NOTE}).

Set these as VARIABLES on the GitHub environment \`staging\` (environment-scoped,
not repository-level; none of them is a secret):
  STAGING_GCP_PROJECT_ID     = ${PROJECT_ID}
  STAGING_GCP_PROJECT_NUMBER = ${PROJECT_NUMBER}
  STAGING_REGION             = ${REGION}
  STAGING_WIF_PROVIDER       = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/$(wif_pool_app)/providers/$(wif_provider)
  STAGING_WIF_INFRA_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/$(wif_pool_infra)/providers/$(wif_provider)
  STAGING_DEPLOYER_SA        = ${DEPLOY_APP_SA}
  STAGING_INFRA_SA           = ${DEPLOY_INFRA_SA}
  STAGING_RUNTIME_SA         = ${RUN_SA}

Then protect the \`staging\` environment: required reviewer (owner), and a
deployment branch policy. The WIF condition requires environment=staging, so an
unprotected environment would let any branch's run obtain the credential.

Next: infra/staging-project/verify-isolation.sh --project-id ${PROJECT_ID}
EOF
