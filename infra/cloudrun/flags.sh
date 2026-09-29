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
# The key that seals per-user secrets (Google refresh tokens, ICS feed URLs).
# Both services share it and the runtime SA already has
# cryptoKeyEncrypterDecrypter on it (infra/bootstrap.sh). Staging only had it
# because someone set it by hand; a production deploy must carry it, or
# Google connect answers `not_configured` and a feed URL cannot be stored.
KMS_KEY_NAME="projects/${PROJECT_ID}/locations/${REGION}/keyRings/maybesitter/cryptoKeys/user-secrets"

case "${TARGET}" in
  staging)
    max_instances=2
    database_id="staging"
    env_name="staging"
    # UC-2.0 (#160) / UC-2.1 (#161): the hosted model.
    llm_provider="gemini"
    # UC-4.5 (#181): the model is on here, so the brakes have to be too.
    ai_disabled="false"
    # UC-2.7a (#167): the memory module, on staging only (owner decision,
    # 2026-09-25). See the "Memory module" comment block below.
    memory_feature="true"
    memory_kill_switch="false"
    global_daily_call_cap="3000"
    # The owner supplied a football-data.org credential on 2026-09-28. Keep
    # the first live sync in staging; production needs its own explicit deploy
    # decision after the provider call and projection are evidenced there.
    football_secret=",FOOTBALL_DATA_API_KEY=maybesitter-football-data-api-key:latest"
    # UC-3.4 (#188): calendar links (ICS feeds), on staging. See the
    # "Calendar links" comment block below.
    ics_feeds="true"
    # No website posts to staging's sign-up, so no origin is allowed there.
    site_origins=""
    ;;
  production)
    max_instances=3
    database_id="(default)"
    env_name="production"
    # OWNER SPEND DECISION (pending): the hosted model and memory on for real
    # users. Nothing else in this block changes. The brakes that remain: the
    # per-user caps below, a production-only global cap of 500 calls/day (a
    # sixth of staging's), and MAYBESITTER_AI_DISABLED /
    # MAYBESITTER_KILL_SWITCH_MEMORY, which an operator flips on the service
    # without a code change.
    #
    # Worst case at the cap: about $4-8/day (~$120-240/month). A call may
    # carry 20,000 characters (~7-10k input tokens) and up to 2,048 output
    # tokens, and withSingleRetry can bill a second request on a timeout;
    # 500 such calls, retried, is the top of that range. Typical pilot use is
    # far below it. The monthly budget alert (100 ILS, ~$27) alerts only; it
    # does not cap.
    #
    # Owner prerequisites before this reaches production (not done here):
    #   - a production-scoped AI alert: "Vertex AI requests above 1500/day"
    #     counts the whole project, and staging alone may reach 3000, so it
    #     cannot see a production spike (infra/cloudrun/ai-cost-alerts.sh);
    #   - MAYBESITTER_LLM_UID_SALT as a secret: unset, model log lines carry an
    #     unsalted sha256 of each uid.
    # With 60 calls/user/day, about 8 heavy users exhaust 500/day; everyone
    # then falls back to the rule-based path until UTC midnight.
    llm_provider="gemini"
    ai_disabled="false"
    memory_feature="true"
    memory_kill_switch="false"
    global_daily_call_cap="500"
    football_secret=""
    # Calendar links stay off here until staging has evidence. This is the
    # switch the owner flips (to "true") in a deliberate production deploy;
    # it is written out, not left unset, so the decision is visible on the
    # service. See the "Calendar links" comment block below.
    ics_feeds="false"
    # The origins the early-access form posts from (lib/earlyAccess/service.ts,
    # exact match). Unset fails closed, and it was only ever on the service by
    # hand. maybesitter.com is the live custom domain; www 301-redirects to it
    # at Hosting, so a form is never posted from www.
    site_origins=";MAYBESITTER_SITE_ORIGINS=https://maybesitter.com,https://maybesitter-app.web.app,https://maybesitter-app.firebaseapp.com"
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
# The owner approved memory for staging on 2026-09-25. Production follows
# with the model (see the production block): the feature flag is on and the
# kill switch is present and `false`, so an operator can take memory out in
# an incident with one value change and no code change, the same way
# `MAYBESITTER_AI_DISABLED` takes out every model call.
#
# ── Calendar links (UC-3.4 #188) ────────────────────────────────────────────
#
# `ICS_FEEDS_ENABLED` (lib/calendar/icsFeeds.ts, on only for the literal
# `true`) gates `/api/mobile/calendar/ics/**` and the 30-minute refresh job
# (infra/scheduler.sh). It was set on neither service, so a build with the
# screen got 404 `feature_disabled` on every call and the owner's phone showed
# «Calendar links are not available in this version.» (2026-09-29).
#
# Staging: on. Production: `false`, written explicitly — the same shape as the
# football credential: production follows only after the fetch, the refresh
# and the proposals are evidenced on staging, by an owner decision.
#
# Every feed URL is sealed with `MAYBESITTER_KMS_KEY_NAME` (fieldEncryption,
# purpose `ics-url` per feed) before it is stored, and both services already
# carry that key, so turning this on needs no other variable. The server
# fetches the URL through `safeFetch` (https only, no private addresses) and no
# model reads a feed, so this is not a spending decision.
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
#
# The env list is `;`-delimited (gcloud's `^;^` form, `gcloud topic escaping`)
# because MAYBESITTER_SITE_ORIGINS is itself a comma-separated list: with the
# default `,` delimiter gcloud would split it into bogus KEY=VALUE pairs. The
# whole flag stays one word with no spaces, since the workflow expands this
# script's output unquoted.
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
  "--update-env-vars=^;^MAYBESITTER_ENV=${env_name};MAYBESITTER_STORAGE_BACKEND=firestore;MAYBESITTER_FIRESTORE_DATABASE_ID=${database_id};GOOGLE_CLOUD_PROJECT=${PROJECT_ID};MAYBESITTER_LLM_PROVIDER=${llm_provider};MAYBESITTER_LLM_MODEL=gemini-2.5-flash;MAYBESITTER_VERTEX_LOCATION=${REGION};MAYBESITTER_GCP_PROJECT=${PROJECT_ID};MAYBESITTER_LLM_TIMEOUT_MS=8000;MAYBESITTER_LLM_MAX_RETRIES=1;MAYBESITTER_AI_DISABLED=${ai_disabled};MAYBESITTER_LLM_DAILY_CALL_CAP=60;MAYBESITTER_LLM_DAILY_TOKEN_CAP=150000;MAYBESITTER_LLM_MINUTE_CALL_CAP=8;MAYBESITTER_LLM_GLOBAL_DAILY_CALL_CAP=${global_daily_call_cap};MAYBESITTER_FEATURE_RECOMMENDATION=true;MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false;MAYBESITTER_NEXT_STEP_ARM=personalized;MAYBESITTER_FEATURE_MEMORY=${memory_feature};MAYBESITTER_KILL_SWITCH_MEMORY=${memory_kill_switch};MAYBESITTER_KMS_KEY_NAME=${KMS_KEY_NAME};ICS_FEEDS_ENABLED=${ics_feeds}${site_origins}" \
  "--set-secrets=MAYBESITTER_DELETION_RECEIPT_PEPPER=maybesitter-deletion-receipt-pepper:latest${football_secret}"
printf '\n'
