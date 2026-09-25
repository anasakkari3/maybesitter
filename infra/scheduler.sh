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
#   infra/scheduler.sh --check staging
#   infra/scheduler.sh --check production
set -euo pipefail

MODE="apply"
if [ "${1:-}" = "--check" ]; then
  MODE="check"
  shift
fi

TARGET="${1:?usage: scheduler.sh [--check] staging|production}"
[ "$#" -eq 1 ] || { echo "usage: scheduler.sh [--check] staging|production" >&2; exit 2; }
PROJECT_ID="${PROJECT_ID:-maybesitter-app}"
REGION="${REGION:-europe-west1}"
SCHEDULER_SA="maybesitter-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

case "${TARGET}" in
  staging)    SERVICE="maybesitter-api-staging"; SUFFIX="staging" ;;
  production) SERVICE="maybesitter-api";         SUFFIX="prod" ;;
  *) echo "unknown target: ${TARGET} (expected staging or production)" >&2; exit 2 ;;
esac

command -v gcloud >/dev/null 2>&1 || { echo "missing required tool: gcloud" >&2; exit 1; }
if [ "${MODE}" = "check" ]; then
  command -v jq >/dev/null 2>&1 || { echo "missing required tool: jq" >&2; exit 1; }
fi

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
CHECK_FAILURES=0
check_equal() { # label, actual, expected
  local label="$1" actual="$2" expected="$3"
  if [ "${actual}" = "${expected}" ]; then
    printf 'OK   %s\n' "${label}"
  else
    printf 'FAIL %s (actual=%q expected=%q)\n' "${label}" "${actual}" "${expected}" >&2
    CHECK_FAILURES=$((CHECK_FAILURES + 1))
  fi
}

if [ "${MODE}" = "check" ]; then
  SERVICE_JSON="$(gcloud run services describe "${SERVICE}" \
    --region "${REGION}" --project "${PROJECT_ID}" --format=json)"
  LIVE_SCHEDULER_SA="$(jq -r '[.spec.template.spec.containers[0].env[]? | select(.name == "MAYBESITTER_SCHEDULER_SA_EMAIL") | .value][0] // ""' <<<"${SERVICE_JSON}")"
  LIVE_AUDIENCE="$(jq -r '[.spec.template.spec.containers[0].env[]? | select(.name == "MAYBESITTER_INTERNAL_AUDIENCE") | .value][0] // ""' <<<"${SERVICE_JSON}")"
  check_equal "${SERVICE} scheduler caller" "${LIVE_SCHEDULER_SA}" "${SCHEDULER_SA}"
  check_equal "${SERVICE} scheduler audience" "${LIVE_AUDIENCE}" "${BASE_URL}"
else
  echo "setting the scheduler identity on ${SERVICE}"
  gcloud run services update "${SERVICE}" \
    --region "${REGION}" --project "${PROJECT_ID}" \
    --update-env-vars="MAYBESITTER_SCHEDULER_SA_EMAIL=${SCHEDULER_SA},MAYBESITTER_INTERNAL_AUDIENCE=${BASE_URL}" \
    >/dev/null
fi

# The audience is the service URL: a token minted for staging cannot be
# replayed against production.
upsert_job() { # name, schedule, path, timezone, description, retry-count, retry-duration, min-backoff, max-backoff
  local name="$1" schedule="$2" path="$3" timezone="$4" description="$5"
  local retry_count="${6:-0}" retry_duration="${7:-0s}"
  local min_backoff="${8:-5s}" max_backoff="${9:-60s}"
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
    --max-retry-attempts="${retry_count}"
    --max-retry-duration="${retry_duration}"
    --min-backoff="${min_backoff}"
    --max-backoff="${max_backoff}"
    --max-doublings=3
    --description="${description}"
  )

  if [ "${MODE}" = "check" ]; then
    local live
    if ! live="$(gcloud scheduler jobs describe "${name}" --location="${REGION}" --project="${PROJECT_ID}" --format=json 2>/dev/null)"; then
      printf 'FAIL scheduler job %s is missing\n' "${name}" >&2
      CHECK_FAILURES=$((CHECK_FAILURES + 1))
      return
    fi
    check_equal "${name} state" "$(jq -r '.state // ""' <<<"${live}")" "ENABLED"
    check_equal "${name} schedule" "$(jq -r '.schedule // ""' <<<"${live}")" "${schedule}"
    check_equal "${name} timezone" "$(jq -r '.timeZone // ""' <<<"${live}")" "${timezone}"
    check_equal "${name} method" "$(jq -r '.httpTarget.httpMethod // ""' <<<"${live}")" "POST"
    check_equal "${name} target" "$(jq -r '.httpTarget.uri // ""' <<<"${live}")" "${uri}"
    check_equal "${name} OIDC caller" "$(jq -r '.httpTarget.oidcToken.serviceAccountEmail // ""' <<<"${live}")" "${SCHEDULER_SA}"
    check_equal "${name} OIDC audience" "$(jq -r '.httpTarget.oidcToken.audience // ""' <<<"${live}")" "${BASE_URL}"
    check_equal "${name} attempt deadline" "$(jq -r '.attemptDeadline // ""' <<<"${live}")" "60s"
    check_equal "${name} retry count" "$(jq -r '.retryConfig.retryCount // 0 | tostring' <<<"${live}")" "${retry_count}"
    check_equal "${name} retry duration" "$(jq -r '.retryConfig.maxRetryDuration // "0s"' <<<"${live}")" "${retry_duration}"
    # Backoff values have no effect when retry_count is zero, so accept the
    # API's defaults for frequent sweeps. For a retrying daily job they are
    # operational behavior and must match the manifest exactly.
    if [ "${retry_count}" -gt 0 ]; then
      check_equal "${name} minimum backoff" "$(jq -r '.retryConfig.minBackoffDuration // ""' <<<"${live}")" "${min_backoff}"
      check_equal "${name} maximum backoff" "$(jq -r '.retryConfig.maxBackoffDuration // ""' <<<"${live}")" "${max_backoff}"
      check_equal "${name} max doublings" "$(jq -r '.retryConfig.maxDoublings // 0 | tostring' <<<"${live}")" "3"
    fi
    return
  fi

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

# The daily-plan sweep (UC-3.10a, #194). Every minute, like the jobs tick and
# for the same reason: the delivery time a user picks is an HH:mm on their own
# clock, so a coarser cron would deliver some mornings late by up to its own
# period. It is a *separate* job from `jobs-tick` so that a plan failure retries
# plan building and never re-runs the reminder queue.
#
# Each tick is one indexed range read over `users` for the accounts whose
# `planSettings.nextRunAt` has arrived, which on a normal minute is none.
upsert_job "daily-plan-tick-${SUFFIX}" "* * * * *" "/api/internal/jobs/daily-plan" "Etc/UTC" \
  "Build due MaybeSitter daily plans (${TARGET})"

# The Must-reminder backup (UC-3.12b, #198). Every minute, and separate from
# the other two for the same reason they are separate from each other: a
# failure here must retry the reminders due in this minute and nothing else.
# Each tick is one collection-group range read over `hardReminders` for the
# rows whose `fireAt` has arrived, which on a normal minute is none.
upsert_job "hard-reminders-tick-${SUFFIX}" "* * * * *" "/api/internal/jobs/hard-reminders" "Etc/UTC" \
  "Send MaybeSitter Must-reminder backups (${TARGET})"

# The watcher sweep (#525). Every minute, and its own job for the reason the
# two ticks above are their own: a 5xx here must retry this sweep and nothing
# else. One run is a bounded collection-group read over `watchers`
# (WATCHER_SWEEP_BATCH) and reports `remaining` when more exist, which the next
# minute takes -- so the call stays well inside the 60s attempt deadline
# without a separate time budget. A retried or overlapping run cannot double
# an effect: firings are keyed by (watcherId, signalId) and created
# transactionally (see lib/watchers/watcherEngine.ts).
upsert_job "watcher-sweep-${SUFFIX}" "* * * * *" "/api/internal/jobs/watchers" "Etc/UTC" \
  "Evaluate MaybeSitter watchers (${TARGET})"

# Continuous replanning (#523). Every five minutes, not every minute like the
# ticks above, and the reason is the pipeline's own burst window rather than
# cost alone: `REPLAN_BURST_WINDOW_MS` coalesces a provider refresh's fan-out
# over 60 seconds, so a per-minute sweep would keep arriving inside a window
# that has not closed and replan on the first notification of a burst, then
# again on the rest -- undoing the coalescing with its own cadence.
#
# Cost is the second reason. Unlike `daily-plan-tick`, a run has no indexed
# "who is due" query to make an idle minute free: it scans `users` and reads
# each account's `planningStateChanges`, so its cost is the size of the user
# base. Nothing it produces is time-critical -- a patch offered for review, or
# a shift of minutes inside a churn budget -- so latency buys nothing here that
# a reminder's cadence buys.
#
# `CONTINUOUS_REPLAN_SWEEP_INTERVAL_MINUTES` in
# lib/services/dailyPlan/continuousReplanService.ts must change with this;
# tests/dailyPlan/continuousReplanControl.test.ts fails when the two disagree.
# Its own job, like every tick above: a 5xx here must retry this sweep and
# nothing else. Re-running is safe -- an auto-applied generation is a
# compare-and-set on the generation it replaces, and a proposal is refused
# when its base generation has moved.
upsert_job "replan-tick-${SUFFIX}" "*/5 * * * *" "/api/internal/jobs/replan" "Etc/UTC" \
  "Replan MaybeSitter days affected by state changes (${TARGET})"

# External calendar feeds (UC-3.4, #188). Every 30 minutes; each feed is
# refreshed every six hours (backing off to 48 after failures), so a run only
# fetches the feeds whose `nextFetchAt` has arrived, at most 100. A separate job
# so a slow or failing university server never delays reminders or plans. The
# route answers {"skipped":"feature_disabled"} until ICS_FEEDS_ENABLED=true.
upsert_job "ics-feed-refresh-${SUFFIX}" "*/30 * * * *" "/api/internal/calendar/ics/refresh" "Etc/UTC" \
  "Refresh due MaybeSitter calendar feeds (${TARGET})"

# The football fixture sync (football fixtures MVP, Task 9): once a night,
# not every minute like the two ticks above -- a fixture list does not change
# hour to hour, so there is nothing to gain from polling it that often, only
# free-tier request budget to waste.
#
# 01:00 Asia/Jerusalem: before `maintenance-daily` (03:17) so the two nightly
# jobs do not land in the same minute, and -- the real reason for choosing the
# small hours specifically -- comfortably before `daily-plan-tick` builds
# anyone's morning plan. `daily-plan-tick` runs every minute and claims
# whichever accounts are due *right now* in their own local time, so there is
# no single "morning" instant this job could dodge for every user; running in
# the deep night is what makes it earlier than everyone's morning, not later
# than anyone's. A football-derived commitment synced after a user's plan was
# already built for the day would not appear in that plan -- see
# `lib/football/projectFixtures.ts` for how a fixture becomes a commitment.
#
# `--attempt-deadline=60s` (below, shared by every job `upsert_job` creates)
# is the deadline `DEFAULT_SYNC_BUDGET_MS` in `lib/football/syncFixtures.ts`
# budgets itself against -- see that file's header and
# `src/app/api/internal/jobs/football-sync/route.ts`'s for the explicit
# statement of that relationship. If this deadline is ever set per-job
# instead of shared, football-sync's must stay above 45s or the budget it was
# built around stops meaning anything.
upsert_job "football-sync-daily-${SUFFIX}" "0 1 * * *" "/api/internal/jobs/football-sync" "Asia/Jerusalem" \
  "Daily MaybeSitter football fixture sync (${TARGET})" 3 900s 30s 300s

# Nightly maintenance at 03:17 local: off-peak, and not on the hour, so it does
# not pile onto every other cron in the world.
upsert_job "maintenance-daily-${SUFFIX}" "17 3 * * *" "/api/internal/jobs/maintenance" "Asia/Jerusalem" \
  "Daily MaybeSitter maintenance (${TARGET})" 3 900s 30s 300s

if [ "${MODE}" = "check" ]; then
  if [ "${CHECK_FAILURES}" -eq 0 ]; then
    printf '\nscheduler check: all checks passed for %s\n' "${TARGET}"
    exit 0
  fi
  printf '\nscheduler check: %d check(s) failed for %s\n' "${CHECK_FAILURES}" "${TARGET}" >&2
  exit 1
fi

cat <<EOF

done. Verify with:
  gcloud scheduler jobs list --location=${REGION} --project=${PROJECT_ID}
  gcloud scheduler jobs run jobs-tick-${SUFFIX} --location=${REGION} --project=${PROJECT_ID}

A run must return 200. This script has just set
MAYBESITTER_SCHEDULER_SA_EMAIL and MAYBESITTER_INTERNAL_AUDIENCE on
${SERVICE}. A 503 means the revision serving traffic predates that. A 401
means the call was refused; the response never says why, but the service
logs do, as "[internal/jobs] refused: <reason>".
EOF
