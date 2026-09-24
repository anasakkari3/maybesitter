#!/usr/bin/env bash
# The cost alarms for the model, as commands rather than console clicks
# (UC-4.5 #181, steps 7a-7d).
#
# Printing is local only. Applying creates user-defined log-based metrics and
# alert policies, whose billing depends on current Observability pricing and
# the project's usage/free allotment. Check billing, quota and approved spend
# before apply; do not assume these resources are free:
# https://cloud.google.com/products/observability/pricing
# Budget alerts are notifications, not a spending cap; application limits live
# in lib/llm/usageGuard.ts where they can actually refuse a model call.
#
# Deliberately NOT here: anything that disables billing. That would take the
# whole app down for everyone rather than just the model, and the app has two
# better brakes — the per-user and global caps, and MAYBESITTER_AI_DISABLED.
#
# Usage:
#   bash infra/cloudrun/ai-cost-alerts.sh print          # show what would run
#   bash infra/cloudrun/ai-cost-alerts.sh apply <email>  # create them
#
# `apply` needs roles/monitoring.editor and roles/logging.configWriter, and for
# the budget, roles/billing.costsManager on the billing account.
set -euo pipefail

MODE="${1:-print}"
NOTIFY_EMAIL="${2:-}"
PROJECT_ID="${PROJECT_ID:-maybesitter-app}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-maybesitter-api}"

if [ "${MODE}" != "print" ] && [ "${MODE}" != "apply" ]; then
  echo "usage: ai-cost-alerts.sh print|apply [notification-email]" >&2
  exit 2
fi
if [ "${MODE}" = "apply" ] && [ -z "${NOTIFY_EMAIL}" ]; then
  echo "apply needs an email address for the notification channel" >&2
  exit 2
fi

run() {
  if [ "${MODE}" = "print" ]; then
    printf '  '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

echo "# 7d — count only globally refused model calls; user caps are not outages."
echo "# The application logs one JSON line per refusal with a scope field,"
echo "# filtered here before counting (lib/llm/captureProvider.ts)."
run gcloud logging metrics create ai_global_quota_exceeded \
  --project="${PROJECT_ID}" \
  --description="Model calls refused by the global daily quota (UC-4.5 #181)" \
  --log-filter='resource.type="cloud_run_revision" AND jsonPayload.event="ai_quota_exceeded" AND jsonPayload.scope="global_daily"'

echo
echo "# The notification channel every policy below reports to."
if [ "${MODE}" = "apply" ]; then
  CHANNEL="$(gcloud alpha monitoring channels create \
    --project="${PROJECT_ID}" \
    --display-name="MaybeSitter owner" \
    --type=email \
    --channel-labels="email_address=${NOTIFY_EMAIL}" \
    --format='value(name)')"
  echo "created channel ${CHANNEL}"
else
  CHANNEL='projects/'"${PROJECT_ID}"'/notificationChannels/CHANNEL_ID'
  printf '  %s\n' "gcloud alpha monitoring channels create --project=${PROJECT_ID} \\"
  printf '    %s\n' "--display-name='MaybeSitter owner' --type=email --channel-labels=email_address=OWNER_EMAIL"
fi

# Metric/ratio contracts (checked 2026-09-24):
# https://docs.cloud.google.com/monitoring/api/metrics_gcp_a_b
# https://docs.cloud.google.com/monitoring/alerts/policies-in-json
# PublisherModel invocation counts cover publisher models, not custom Endpoints.
# The daily alert is a rolling 24-hour monitoring window, not the app's daily cap.
# Ratio operands must have identical alignment and labels; REDUCE_SUM removes
# revision/status partitions so heavy and light revisions are weighted by calls.
# This generates configuration; it does not prove deployed metrics contain data.
#
# Each policy is written to a file and created from it: the condition filters
# contain commas and quotes that do not survive being passed inline.
policy() {
  local name="$1" filter="$2" comparison="$3" threshold="$4" duration="$5" aligner="$6"
  local period="${7:-600s}" reducer="${8:-REDUCE_SUM}" denominator="${9:-}"
  local denominator_json=""
  if [ -n "${denominator}" ]; then
    denominator_json=', "denominatorFilter": '"${denominator}"', "denominatorAggregations": [{"alignmentPeriod": "'"${period}"'", "perSeriesAligner": "'"${aligner}"'", "crossSeriesReducer": "'"${reducer}"'"}]'
  fi
  local file
  file="$(mktemp)"
  cat > "${file}" <<JSON
{
  "displayName": "${name}",
  "combiner": "OR",
  "conditions": [{
    "displayName": "${name}",
    "conditionThreshold": {
      "filter": ${filter},
      "comparison": "${comparison}",
      "thresholdValue": ${threshold},
      "duration": "${duration}",
      "aggregations": [{"alignmentPeriod": "${period}", "perSeriesAligner": "${aligner}", "crossSeriesReducer": "${reducer}"}]${denominator_json}
    }
  }],
  "notificationChannels": ["${CHANNEL}"]
}
JSON
  if [ "${MODE}" = "print" ]; then
    printf '  gcloud alpha monitoring policies create --project=%s --policy-from-file=- <<EOF\n' "${PROJECT_ID}"
    sed 's/^/  /' "${file}"
    printf 'EOF\n'
  else
    gcloud alpha monitoring policies create --project="${PROJECT_ID}" --policy-from-file="${file}"
  fi
  rm -f "${file}"
}

echo
echo "# 7a — Vertex request count above 1500/day."
policy "Vertex AI requests above 1500/day" \
  '"metric.type=\"aiplatform.googleapis.com/publisher/online_serving/model_invocation_count\" resource.type=\"aiplatform.googleapis.com/PublisherModel\""' \
  "COMPARISON_GT" "1500" "0s" "ALIGN_SUM" "86400s"

echo
echo "# 7b — Cloud Run 5xx above 5% over ten minutes."
policy "Cloud Run 5xx above 5%" \
  '"metric.type=\"run.googleapis.com/request_count\" resource.type=\"cloud_run_revision\" resource.label.\"service_name\"=\"'"${SERVICE}"'\" metric.label.\"response_code_class\"=\"5xx\""' \
  "COMPARISON_GT" "0.05" "0s" "ALIGN_SUM" "600s" "REDUCE_SUM" \
  '"metric.type=\"run.googleapis.com/request_count\" resource.type=\"cloud_run_revision\" resource.label.\"service_name\"=\"'"${SERVICE}"'\""'

echo
echo "# 7c — instance count at the ceiling for fifteen minutes."
policy "Cloud Run pinned at max instances" \
  '"metric.type=\"run.googleapis.com/container/instance_count\" resource.type=\"cloud_run_revision\" resource.label.\"service_name\"=\"'"${SERVICE}"'\""' \
  "COMPARISON_GTE" "3" "900s" "ALIGN_MEAN" "60s"

echo
echo "# 7d — any globally-scoped refusal at all. One of these means every user"
echo "#      is being refused, which is a different problem from one heavy account."
policy "Model refused for everyone (global quota)" \
  '"metric.type=\"logging.googleapis.com/user/ai_global_quota_exceeded\" resource.type=\"cloud_run_revision\""' \
  "COMPARISON_GT" "0" "0s" "ALIGN_SUM"

echo
echo "# 7 — the budget's threshold rules. The budget itself already exists and"
echo "#     stays alert-only; this adds the 25/50/90/100% actual and 100%"
echo "#     forecast rules. Needs the billing account id, which is not in this"
echo "#     repository on purpose."
printf '  %s\n' "gcloud billing budgets update BUDGET_ID --billing-account=BILLING_ACCOUNT_ID \\"
printf '    %s\n' "--threshold-rule=percent=0.25 --threshold-rule=percent=0.5 \\"
printf '    %s\n' "--threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \\"
printf '    %s\n' "--threshold-rule=percent=1.0,basis=forecasted-spend"

echo
echo "# Firestore TTL on the usage counters (7 days, field expireAt)."
run gcloud firestore fields ttls update expireAt \
  --collection-group=usage --project="${PROJECT_ID}" --async
run gcloud firestore fields ttls update expireAt \
  --collection-group=llmUsage --project="${PROJECT_ID}" --async
