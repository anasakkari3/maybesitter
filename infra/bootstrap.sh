#!/usr/bin/env bash
# Bootstrap the MaybeSitter Google Cloud and Firebase project (UC-1.0a, #140).
#
# Idempotent: every create is guarded by a describe, so a second run changes
# nothing. Run it again after editing rather than patching by hand in the
# console — the console is not reviewable and not reproducible.
#
# Region decision: europe-west1. Firestore's location can never be changed, so
# it has to be a region where every later service is fully available. Cloud
# Run, Cloud Scheduler, Artifact Registry and Vertex AI Gemini are all GA there
# with the full model catalogue; me-west1 has a narrower Vertex list and Tier-2
# pricing, which matters under a small budget. ~60 ms from Israel is fine for
# this API, and Israeli privacy law allows transfer to EU member states.
#
# Prerequisites (owner, once — an agent must not do these):
#   brew install --cask google-cloud-sdk
#   gcloud auth login && gcloud auth application-default login
#   gcloud config set project maybesitter-app
#   firebase login
#
# Usage:
#   GITHUB_REPOSITORY=owner/repo infra/bootstrap.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-maybesitter-app}"
REGION="${REGION:-europe-west1}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY=owner/repo}"
SECRET_NAME="maybesitter-deletion-receipt-pepper"
ARTIFACT_REPO="maybesitter"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RUN_SA="maybesitter-run@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA="maybesitter-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="maybesitter-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

say() { printf '\n=== %s\n' "$1"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
# retry ATTEMPTS DELAY_SECONDS COMMAND... — for calls that fail transiently.
retry() {
  local attempts="$1" delay="$2" n=1
  shift 2
  until "$@"; do
    if [ "${n}" -ge "${attempts}" ]; then return 1; fi
    echo "  retrying in ${delay}s (${n}/${attempts})"
    sleep "${delay}"
    n=$((n + 1))
  done
}

need gcloud
need firebase

say "project ${PROJECT_ID} in ${REGION}"
gcloud config set project "${PROJECT_ID}" >/dev/null

say "enabling APIs"
gcloud services enable \
  firebase.googleapis.com \
  firestore.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  fcm.googleapis.com \
  identitytoolkit.googleapis.com \
  aiplatform.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  firebaserules.googleapis.com \
  --project "${PROJECT_ID}"

say "Firebase"
if firebase projects:list --json 2>/dev/null | grep -q "\"${PROJECT_ID}\""; then
  echo "already a Firebase project"
else
  firebase projects:addfirebase "${PROJECT_ID}"
fi

# Two databases in one project: production uses (default) and the staging
# service uses `staging` (infra/cloudrun/flags.sh). Staging and production
# share Firebase Auth, so the database is the only thing keeping staging's test
# accounts out of production data; the app refuses to run staging on (default)
# for that reason (lib/storage/firestoreAdapter). Keep this list in step with
# FIRESTORE_DATABASES in infra/verify.sh and the `firestore` array in
# firebase.json — tests/storage/firestoreDatabases.test.ts checks all three.
FIRESTORE_DATABASES=('(default)' 'staging')
for database in "${FIRESTORE_DATABASES[@]}"; do
  say "Firestore ${database} database"
  if gcloud firestore databases describe --database="${database}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "already exists"
  else
    gcloud firestore databases create \
      --database="${database}" \
      --location="${REGION}" \
      --type=firestore-native \
      --delete-protection \
      --project "${PROJECT_ID}"
  fi
  # Point-in-time recovery is the backup story. Both settings are re-applied on
  # every run, so a database that predates them is brought into line too.
  # A database created seconds ago is still settling, and an update then fails
  # with "ABORTED: There are concurrent database changes" — seen on the first
  # real run. That is transient, so it is retried rather than failing the run.
  retry 8 15 gcloud firestore databases update --database="${database}" --enable-pitr --delete-protection --project "${PROJECT_ID}"
done

say "Artifact Registry"
if gcloud artifacts repositories describe "${ARTIFACT_REPO}" \
  --location="${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "already exists"
else
  gcloud artifacts repositories create "${ARTIFACT_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="MaybeSitter container images" \
    --project "${PROJECT_ID}"
fi
gcloud artifacts repositories set-cleanup-policies "${ARTIFACT_REPO}" \
  --location="${REGION}" --project "${PROJECT_ID}" \
  --policy="${HERE}/artifact-cleanup.json" --no-dry-run

say "service accounts"
create_sa() { # name, display name
  if gcloud iam service-accounts describe "${1}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "sa ${1} exists"
  else
    gcloud iam service-accounts create "${1}" --display-name="${2}" --project "${PROJECT_ID}"
  fi
}
create_sa maybesitter-run "Cloud Run runtime"
create_sa maybesitter-deployer "GitHub Actions deployer (WIF)"
create_sa maybesitter-scheduler "Cloud Scheduler OIDC identity"

# Least privilege: exactly these roles, nothing wider. The scheduler SA gets no
# project role at all — the app authorises it by checking the token's email.
say "roles"
add_role() { gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${1}" --role="${2}" --condition=None >/dev/null; }
add_role "${RUN_SA}" roles/datastore.user
add_role "${RUN_SA}" roles/firebaseauth.admin
# run.admin, not run.developer: infra/cloudrun/flags.sh deploys with
# --allow-unauthenticated (the app authenticates every request itself), and
# making a service public needs run.services.setIamPolicy, which run.developer
# lacks. Without it the first deploy creates a private service and the smoke
# test gets 403.
add_role "${DEPLOYER_SA}" roles/run.admin
add_role "${DEPLOYER_SA}" roles/firebaserules.admin
add_role "${DEPLOYER_SA}" roles/datastore.indexAdmin
# firebase-tools checks that the Firestore API is enabled before deploying rules
# and indexes (ensureApiEnabled.check: GET serviceusage .../services/firestore,
# sent with x-goog-user-project), and does not catch a 403 there — so without
# serviceusage.services.get and .use the rules step fails outright.
add_role "${DEPLOYER_SA}" roles/serviceusage.serviceUsageConsumer

gcloud artifacts repositories add-iam-policy-binding "${ARTIFACT_REPO}" \
  --location="${REGION}" --project "${PROJECT_ID}" \
  --member="serviceAccount:${DEPLOYER_SA}" --role=roles/artifactregistry.writer >/dev/null
gcloud iam service-accounts add-iam-policy-binding "${RUN_SA}" \
  --project "${PROJECT_ID}" \
  --member="serviceAccount:${DEPLOYER_SA}" --role=roles/iam.serviceAccountUser >/dev/null

say "secret container ${SECRET_NAME} (no value)"
if gcloud secrets describe "${SECRET_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "already exists"
else
  gcloud secrets create "${SECRET_NAME}" \
    --replication-policy=user-managed --locations="${REGION}" --project "${PROJECT_ID}"
  echo "OWNER: add the value without echoing it:"
  echo "  openssl rand -hex 32 | gcloud secrets versions add ${SECRET_NAME} --data-file=-"
fi
# The runtime SA may read this one secret and no other.
gcloud secrets add-iam-policy-binding "${SECRET_NAME}" --project "${PROJECT_ID}" \
  --member="serviceAccount:${RUN_SA}" --role=roles/secretmanager.secretAccessor >/dev/null

say "Workload Identity Federation for ${GITHUB_REPOSITORY}"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
if gcloud iam workload-identity-pools describe github \
  --location=global --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "pool exists"
else
  gcloud iam workload-identity-pools create github \
    --location=global --display-name="GitHub Actions" --project "${PROJECT_ID}"
fi
if gcloud iam workload-identity-pools providers describe github-actions \
  --workload-identity-pool=github --location=global --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "provider exists"
else
  gcloud iam workload-identity-pools providers create-oidc github-actions \
    --workload-identity-pool=github --location=global --project "${PROJECT_ID}" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${GITHUB_REPOSITORY}' && assertion.ref=='refs/heads/main'"
fi
gcloud iam service-accounts add-iam-policy-binding "${DEPLOYER_SA}" \
  --project "${PROJECT_ID}" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${GITHUB_REPOSITORY}" >/dev/null

say "Firebase apps (one identifier on both platforms)"
APPS_JSON="$(firebase apps:list --project "${PROJECT_ID}" --json 2>/dev/null || echo '{}')"
echo "${APPS_JSON}" | grep -q '"com.maybesitter.app".*IOS\|IOS.*com.maybesitter.app' \
  || firebase apps:create IOS "MaybeSitter iOS" --bundle-id com.maybesitter.app --project "${PROJECT_ID}" || true
echo "${APPS_JSON}" | grep -q '"com.maybesitter.app".*ANDROID\|ANDROID.*com.maybesitter.app' \
  || firebase apps:create ANDROID "MaybeSitter Android" --package-name com.maybesitter.app --project "${PROJECT_ID}" || true

cat <<EOF

=== done. Record these as GitHub repository VARIABLES (not secrets, not keys):
  GCP_WIF_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github-actions
  GCP_DEPLOYER_SA  = ${DEPLOYER_SA}

Cloud Scheduler will sign its OIDC tokens as:
  ${SCHEDULER_SA}
(UC-1.0d #143 passes that as --oidc-service-account-email; the app authorises
it by checking the token's email, so it needs no project role.)

Owner steps that cannot be scripted:
  1. Firebase console -> Authentication -> Sign-in method: enable Email/Password, Google, Apple.
  2. Restrict the auto-created API keys to the iOS bundle and Android package.
  3. Add the secret value (command printed above) if it was just created.
  4. Confirm the budget alert thresholds at 50/90/100%.

Then run: infra/verify.sh
EOF
