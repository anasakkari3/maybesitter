#!/usr/bin/env bash
# Print the `gcloud run deploy` flags for one environment (UC-1.0d #143).
#
# The deploy workflow and a human running a manual deploy read the settings
# from here, so the two cannot drift.
#
# Usage:  gcloud run deploy <service> --image … $(infra/cloudrun/flags.sh staging)
set -euo pipefail

TARGET="${1:?usage: flags.sh staging|production}"
PROJECT_ID="${PROJECT_ID:-maybesitter-app}"
REGION="${REGION:-europe-west1}"
RUN_SA="maybesitter-run@${PROJECT_ID}.iam.gserviceaccount.com"

case "${TARGET}" in
  staging)
    max_instances=2
    database_id="staging"
    env_name="staging"
    # UC-2.0 (#160) / UC-2.1 (#161): the hosted model, on staging only.
    # Production stays `none` until the owner decides otherwise — enabling a
    # paid model for real users is not something a deploy should do by itself.
    llm_provider="gemini"
    # UC-4.5 (#181): the model is on here, so the brakes have to be too.
    ai_disabled="false"
    # UC-2.7a (#167): the memory module, on staging only (owner decision,
    # 2026-09-25). See the "Memory module" comment block below.
    memory_feature="true"
    memory_kill_switch="false"
    ;;
  production)
    max_instances=3
    database_id="(default)"
    env_name="production"
    llm_provider="none"
    # Belt and braces. The provider is already `none`, and this is the switch an
    # operator flips without a code change if that ever stops being true.
    ai_disabled="true"
    memory_feature="false"
    memory_kill_switch="true"
    ;;
  *)
    echo "unknown target: ${TARGET} (expected staging or production)" >&2
    exit 2
    ;;
esac

# ── Cost guardrails (UC-4.5 #181) ───────────────────────────────────────────
#
# The Cloud Run bounds this issue asks for were already here from UC-1.0d
# (#143): --timeout=60, --concurrency=40, --min-instances=0 and a bounded
# --max-instances. Two deliberate differences from the issue's text:
#
#   --memory=1Gi, not 512Mi. #143 chose 1Gi against the real image; halving it
#     to match a number written before the image existed risks an OOM on a cold
#     start, and the memory is not what the model costs.
#   --max-instances=3 for production is kept. #181 made raising it conditional
#     on no process-local write queue remaining; `grep -r "class .*Queue" src lib`
#     finds none, so the condition holds.
#
# ── The next step (UC-2.9 #170) ─────────────────────────────────────────────
#
# `MAYBESITTER_FEATURE_RECOMMENDATION` was set in neither environment, so
# `resolveNextStepAccess` answered `feature_disabled` everywhere and no user
# has ever seen a next step on a deployed build.
#
# Both environments get it on. Every arm is deterministic and local — the
# selector reads the user's own commitments and nothing else, and
# `getLiveNextStep` records `costMicros: 0` — so unlike the model provider this
# is not a spending decision. It still reaches production only through the
# hand-dispatched deploy, which is a protected environment with the owner as a
# required reviewer.
#
# `MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false` is set rather than left unset,
# so the switch an operator flips in an incident is already present on the
# service and turning it on is a one-value change instead of adding a variable
# under pressure. See docs/operations/V03_CLOSED_PILOT_RUNBOOK.md.
#
# `MAYBESITTER_NEXT_STEP_ARM=personalized` pins the arm while no experiment is
# running. `selectNextStepForArm` falls back to baseline ordering when the user
# has too little history for `profileIsUsable`, so a new account gets exactly
# the reviewed generic behaviour rather than something invented from nothing.
# `MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS` stays unset: there is no trial.
#
# ── Memory module (UC-2.7a #167) ────────────────────────────────────────────
#
# `memory` gates `/api/mobile/memory` and `/api/mobile/profile/*` (goals,
# personalization, routine sync, setup-chat describe, AI context import).
# Unlike the next step above, this one is not deterministic-and-local: memory
# candidates and the AI context import call the hosted model, which is a
# spending decision the same way `llm_provider` is.
#
# The owner approved memory for staging only (2026-09-25); production stays
# off until that is revisited deliberately. `memory_feature=false` in
# production matches `MODULE_FEATURE_FLAG_DEFAULTS.memory` in
# `src/contracts/v1/runtimeControls.ts`, so this line changes no behaviour —
# it is written explicitly so the decision is visible on the deployed
# service's own env vars rather than resting on a default nobody reading
# `gcloud run services describe` would see.
#
# `memory_kill_switch=true` in production is belt and braces, the same shape
# as `ai_disabled` above: the feature flag already keeps memory off, and the
# kill switch is a second, independent block, so a future accidental
# `MAYBESITTER_FEATURE_MEMORY=true` on production cannot turn it on by
# itself. Staging sets the switch explicitly to `false` for the opposite
# reason `MAYBESITTER_KILL_SWITCH_RECOMMENDATION` does: the switch an
# operator flips in an incident is already present on the service.
#
# CPU throttling is the Cloud Run default and is not passed explicitly: the flag
# to *disable* it (--no-cpu-throttling) is the one that costs money, and it is
# absent.
#
# --allow-unauthenticated: the app authenticates every request itself with a
#   Firebase ID token (UC-1.0e #144), so Cloud Run IAM would only duplicate it.
# --min-instances=0 keeps the bill near zero; --max-instances doubles as a cost
#   circuit-breaker. Revisit min=1 for production at launch (#205).
# Secrets come only through --set-secrets, never as plain env values.
# Environment is merged, not replaced: infra/scheduler.sh sets
# MAYBESITTER_SCHEDULER_SA_EMAIL and MAYBESITTER_INTERNAL_AUDIENCE on the
# service (the audience is the service's own URL, which only exists after
# the first deploy). --set-env-vars replaces the whole set, so every deploy
# would erase them and the internal job routes would answer 503 until
# someone re-ran scheduler.sh.
printf '%s ' \
  "--region=${REGION}" \
  "--service-account=${RUN_SA}" \
  "--allow-unauthenticated" \
  "--port=8080" \
  "--cpu=1" \
  "--memory=1Gi" \
  "--execution-environment=gen2" \
  "--cpu-boost" \
  "--timeout=60" \
  "--concurrency=40" \
  "--min-instances=0" \
  "--max-instances=${max_instances}" \
  "--startup-probe=httpGet.path=/api/health/ready,periodSeconds=5,failureThreshold=6" \
  "--update-env-vars=MAYBESITTER_ENV=${env_name},MAYBESITTER_STORAGE_BACKEND=firestore,MAYBESITTER_FIRESTORE_DATABASE_ID=${database_id},GOOGLE_CLOUD_PROJECT=${PROJECT_ID},MAYBESITTER_LLM_PROVIDER=${llm_provider},MAYBESITTER_LLM_MODEL=gemini-2.5-flash,MAYBESITTER_VERTEX_LOCATION=${REGION},MAYBESITTER_GCP_PROJECT=${PROJECT_ID},MAYBESITTER_LLM_TIMEOUT_MS=8000,MAYBESITTER_LLM_MAX_RETRIES=1,MAYBESITTER_AI_DISABLED=${ai_disabled},MAYBESITTER_LLM_DAILY_CALL_CAP=60,MAYBESITTER_LLM_DAILY_TOKEN_CAP=150000,MAYBESITTER_LLM_MINUTE_CALL_CAP=8,MAYBESITTER_LLM_GLOBAL_DAILY_CALL_CAP=3000,MAYBESITTER_FEATURE_RECOMMENDATION=true,MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false,MAYBESITTER_NEXT_STEP_ARM=personalized,MAYBESITTER_FEATURE_MEMORY=${memory_feature},MAYBESITTER_KILL_SWITCH_MEMORY=${memory_kill_switch}" \
  "--set-secrets=MAYBESITTER_DELETION_RECEIPT_PEPPER=maybesitter-deletion-receipt-pepper:latest"
printf '\n'
