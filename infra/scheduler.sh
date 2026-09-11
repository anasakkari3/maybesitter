#!/usr/bin/env bash
# Create the Cloud Scheduler jobs that drive periodic work (UC-1.0d, #143).
#
# Cloud Run instances idle with throttled CPU and scale to zero, so an
# in-process setInterval does not run reliably — and a worker process beside
# the server would have to be kept alive and paid for. Scheduler calls the
# service instead, and each call carries an OIDC token the route verifies
# (audience + the scheduler service account's email), so the endpoints are not
# open to the internet even though the service is.
#
# Idempotent: each job is updated when it already exists, created otherwise.
#
# Usage:
#   infra/scheduler.sh staging
#   infra/scheduler.sh production
set -euo pipefail

TARGET="${1:?usage: scheduler.sh staging|production}"
PROJECT_ID="${PROJECT_ID:-maybesitter-app}"
REGION="${REGION:-europe-west1}"
SCHEDULER_SA="maybesitter-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

case "${TARGET}" in
  staging)    SERVICE="maybesitter-api-staging"; SUFFIX="staging" ;;
  production) SERVICE="maybesitter-api";         SUFFIX="prod" ;;
  *) echo "unknown target: ${TARGET} (expected staging or production)" >&2; exit 2 ;;
esac

command -v gcloud >/dev/null 2>&1 || { echo "missing required tool: gcloud" >&2; exit 1; }

BASE_URL="$(gcloud run services describe "${SERVICE}" \
  --region "${REGION}" --project "${PROJECT_ID}" --format='value(status.url)')"
if [ -z "${BASE_URL}" ]; then
  echo "could not resolve the URL of ${SERVICE}; deploy it first (see docs/operations/DEPLOY.md)" >&2
  exit 1
fi
echo "service ${SERVICE} -> ${BASE_URL}"

# The routes verify the caller themselves (lib/auth/schedulerOidc), and they
# can only do that once the service knows which caller to accept and which
# audience to expect. Neither can live in `infra/cloudrun/flags.sh`: the
# audience is the service's own URL, which Cloud Run only assigns at the first
# deploy, and that URL embeds the project number, which is not committed.
# Here both are known, so this is where they are set.
#
# Without them the routes answer 503 rather than running anything — they fail
# closed — so a deploy that never reaches this script stops jobs rather than
# running them unauthenticated.
#
# `--update-env-vars` leaves every other variable alone, and re-running with
# the same values is harmless.
echo "setting the scheduler identity on ${SERVICE}"
gcloud run services update "${SERVICE}" \
  --region "${REGION}" --project "${PROJECT_ID}" \
  --update-env-vars="MAYBESITTER_SCHEDULER_SA_EMAIL=${SCHEDULER_SA},MAYBESITTER_INTERNAL_AUDIENCE=${BASE_URL}" \
  >/dev/null

# The audience is the service URL: a token minted for staging cannot be
# replayed against production.
upsert_job() { # name, schedule, path, timezone, description
  local name="$1" schedule="$2" path="$3" timezone="$4" description="$5"
  local uri="${BASE_URL}${path}"
  local -a args=(
    --location="${REGION}"
    --project="${PROJECT_ID}"
    --schedule="${schedule}"
    --time-zone="${timezone}"
    --uri="${uri}"
    --http-method=POST
    --oidc-service-account-email="${SCHEDULER_SA}"
    --oidc-token-audience="${BASE_URL}"
    --attempt-deadline=60s
    --description="${description}"
  )

  if gcloud scheduler jobs describe "${name}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "updating ${name}"
    gcloud scheduler jobs update http "${name}" "${args[@]}" >/dev/null
  else
    echo "creating ${name}"
    gcloud scheduler jobs create http "${name}" "${args[@]}" >/dev/null
  fi
}

# One minute is Cloud Scheduler's floor. It replaces the old 30-second
# in-process poll; reminders are not second-accurate, and a minute of latency
# is invisible next to the lead times users choose.
upsert_job "jobs-tick-${SUFFIX}" "* * * * *" "/api/internal/jobs/run" "Etc/UTC" \
  "Run due MaybeSitter jobs (${TARGET})"

# Nightly maintenance at 03:17 local: off-peak, and not on the hour, so it does
# not pile onto every other cron in the world.
upsert_job "maintenance-daily-${SUFFIX}" "17 3 * * *" "/api/internal/jobs/maintenance" "Asia/Jerusalem" \
  "Daily MaybeSitter maintenance (${TARGET})"

cat <<EOF

done. Verify with:
  gcloud scheduler jobs list --location=${REGION} --project=${PROJECT_ID}
  gcloud scheduler jobs run jobs-tick-${SUFFIX} --location=${REGION} --project=${PROJECT_ID}

A run must return 200. This script has just set
MAYBESITTER_SCHEDULER_SA_EMAIL and MAYBESITTER_INTERNAL_AUDIENCE on
${SERVICE}, so a 401 means traffic is still being served by an older
revision, and a 403 means the job is calling with a service account other
than ${SCHEDULER_SA}.
EOF
