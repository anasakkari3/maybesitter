#!/usr/bin/env bash
# Print the `gcloud run deploy` flags for one environment (UC-1.0d #143).
#
# The deploy workflow and a human running a manual deploy read the settings
# from here, so the two cannot drift.
#
# Usage (capture first, so a refusal stops the deploy; under `set -e` a failing
# $(...) inside another command's arguments is ignored):
#   FLAGS="$(bash infra/cloudrun/flags.sh staging)"
#   read -ra FLAG_WORDS <<<"${FLAGS}"
#   gcloud run deploy <service> --image … "${FLAG_WORDS[@]}"
set -euo pipefail

TARGET="${1:?usage: flags.sh staging|production}"
PROJECT_ID="${PROJECT_ID:-maybesitter-app}"
REGION="${REGION:-europe-west1}"
RUN_SA="maybesitter-run@${PROJECT_ID}.iam.gserviceaccount.com"
# The only caller /api/internal/m5a-controls accepts (#810). See the "M5a
# controls caller" comment block below.
DEPLOYER_SA="maybesitter-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
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
    capture_kinds="true"
    free_slots="true"
    m4b_features="true"
    proactive_loop="true"
    m5a_features="true"
    m5b_features="true"
    m6_features="true"
    memory_translation="true"
    # UC-2.0 (#160) / UC-2.1 (#161): the hosted model.
    llm_provider="gemini"
    # UC-4.5 (#181): the model is on here, so the brakes have to be too.
    ai_disabled="false"
    # UC-2.7a (#167): the memory module (staging since the owner decision of
    # 2026-09-25). See the "Memory module" comment block below.
    memory_feature="true"
    memory_kill_switch="false"
    global_daily_call_cap="3000"
    # UC-3.4 (#188): calendar links (ICS feeds). See the "Calendar links"
    # comment block below.
    ics_feeds="true"
    # No website posts to staging's sign-up, so no origin is allowed there.
    site_origins=""
    ;;
  production)
    max_instances=3
    database_id="(default)"
    env_name="production"
    capture_kinds="false"
    free_slots="false"
    m4b_features="false"
    # OWNER DECISION (2026-10-01): the proactive loop (MaybeSitter's "brain":
    # proactive suggestions, outcome learning, opt-in Gmail monitoring) is
    # released to production for everyone. MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP
    # takes it out in one value change; model calls stay under the caps below.
    proactive_loop="true"
    # M5a remains RELEASE_LOCKED in production.
    m5a_features="false"
    # M5b-1 is staging-only until Market Evidence Gate #61.
    m5b_features="false"
    # M6a-1 remains RELEASE_LOCKED in production.
    m6_features="false"
    memory_translation="false"
    # OWNER DECISION (2026-09-29): one product. Production gets the same
    # features as staging — the hosted model and memory, football fixtures and
    # calendar links — and the owner approved the model spend below. The
    # brakes that remain: the
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
    # The two prerequisites the spend decision named:
    #   - a production-scoped AI alert: "Vertex AI requests above 1500/day"
    #     counts the whole project, and staging alone may reach 3000, so it
    #     cannot see a production spike. infra/cloudrun/ai-cost-alerts.sh now
    #     defines one on production's own `llm_call` log lines (above 400/day,
    #     80% of the cap); an operator runs its `apply`;
    #   - MAYBESITTER_LLM_UID_SALT: mounted from Secret Manager on both
    #     services (--set-secrets below), so model log lines carry a salted
    #     hash of each uid.
    # With 60 calls/user/day, about 8 heavy users exhaust 500/day; everyone
    # then falls back to the rule-based path until UTC midnight.
    llm_provider="gemini"
    ai_disabled="false"
    memory_feature="true"
    memory_kill_switch="false"
    global_daily_call_cap="500"
    # Calendar links on, by the owner decision above. The KMS key that seals
    # each feed URL is already on this service. See the "Calendar links"
    # comment block below.
    ics_feeds="true"
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

# ── Deletion-receipt pepper rotation (#798) ─────────────────────────────────
#
# The pepper names the account-deletion tombstone (#794), so a rotation is two
# deploys per service, driven by the committed state in pepper-rotation.env
# (runbook: docs/operations/GCP_BOOTSTRAP.md, "Rotating the deletion-receipt
# pepper"):
#
#   steady   PEPPER=<current>                      WRITE=current
#   readers  PEPPER=<new>, PREVIOUS=<old>          WRITE=previous   (phase 1)
#   writer   PEPPER=<new>, PREVIOUS=<old>          WRITE=current    (phase 2)
#
# Why it lives in a file and not in the workflow: --set-secrets replaces the
# whole mounted set, and staging deploys on every merge, so a PREVIOUS mapping
# added by hand would be dropped by the next unrelated deploy. A committed file
# is read by every deploy, the workflow's and a human's alike, and is the same
# input the tests run against (MAYBESITTER_PEPPER_ROTATION_FILE points them at
# fixtures).
#
# WRITE is always emitted, `current` included. --update-env-vars merges, so a
# `previous` left on the service by an earlier phase would otherwise survive
# the return to steady.
ROTATION_FILE="${MAYBESITTER_PEPPER_ROTATION_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pepper-rotation.env}"
ROTATION_KEYS="staging_phase staging_current_version staging_previous_version production_phase production_current_version production_previous_version"

rotation_fail() {
  echo "pepper-rotation.env: $1 (${ROTATION_FILE})" >&2
  exit 2
}

[ -r "${ROTATION_FILE}" ] || rotation_fail "cannot read the rotation state file"
rotation_seen=" "
while IFS= read -r line || [ -n "${line}" ]; do
  case "${line}" in ''|'#'*) continue ;; esac
  case "${line}" in *=*) ;; *) rotation_fail "\"${line}\" is not KEY=VALUE" ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  case " ${ROTATION_KEYS} " in *" ${key} "*) ;; *) rotation_fail "unknown key ${key}" ;; esac
  case "${rotation_seen}" in *" ${key} "*) rotation_fail "${key} is set twice" ;; esac
  case "${value}" in *[!A-Za-z0-9]*) rotation_fail "${key} has a value with characters other than letters and digits" ;; esac
  rotation_seen="${rotation_seen}${key} "
  printf -v "rot_${key}" '%s' "${value}"
done < "${ROTATION_FILE}"

for key in ${ROTATION_KEYS}; do
  case "${rotation_seen}" in *" ${key} "*) ;; *) rotation_fail "${key} is missing" ;; esac
done

# Every service's state is checked, not only the target's: a broken line for
# production must fail the staging deploy and the tests, not wait for the
# production dispatch.
is_version() { case "$1" in ''|*[!0-9]*|0*) return 1 ;; *) return 0 ;; esac; }
for service in staging production; do
  phase_var="rot_${service}_phase"
  current_var="rot_${service}_current_version"
  previous_var="rot_${service}_previous_version"
  phase="${!phase_var}"
  current="${!current_var}"
  previous="${!previous_var}"
  case "${phase}" in
    steady)
      [ "${current}" = "latest" ] || is_version "${current}" || rotation_fail "${service}_current_version must be latest or a version number"
      [ -z "${previous}" ] || rotation_fail "${service}_previous_version must be empty while ${service} is steady"
      ;;
    readers|writer)
      is_version "${current}" || rotation_fail "${service}_current_version must be a pinned version number during a rotation"
      is_version "${previous}" || rotation_fail "${service}_previous_version must be a pinned version number during a rotation"
      [ "${current}" != "${previous}" ] || rotation_fail "${service} rotates from version ${previous} to itself"
      ;;
    *)
      rotation_fail "${service}_phase must be steady, readers or writer"
      ;;
  esac
done

phase_var="rot_${TARGET}_phase"
current_var="rot_${TARGET}_current_version"
previous_var="rot_${TARGET}_previous_version"
PEPPER_SECRET="maybesitter-deletion-receipt-pepper"
pepper_secrets="MAYBESITTER_DELETION_RECEIPT_PEPPER=${PEPPER_SECRET}:${!current_var}"
case "${!phase_var}" in
  steady)
    pepper_write="current"
    ;;
  readers)
    pepper_write="previous"
    pepper_secrets="${pepper_secrets},MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS=${PEPPER_SECRET}:${!previous_var}"
    ;;
  writer)
    pepper_write="current"
    pepper_secrets="${pepper_secrets},MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS=${PEPPER_SECRET}:${!previous_var}"
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
# ── Share to MaybeSitter (#share-intake) ────────────────────────────────────
#
# `SHARE_INTAKE_ENABLED` (lib/services/share/shareFlags.ts, on for true/1/yes)
# gates `/api/mobile/capture/share`. It was set on neither service, so text
# shared from another app reached the phone and then got 404
# `feature_unavailable` in 4 ms, before any model read it (owner's Redmi on
# production, 2026-09-30 14:24Z). The phone build has had the share flag on
# since #667. On in both environments, same owner decision as calendar links.
# The model call goes through `shareLlmProvider` under the same per-user and
# global caps, so this adds no new spending ceiling.
#
# ── Calendar links (UC-3.4 #188) ────────────────────────────────────────────
#
# `ICS_FEEDS_ENABLED` (lib/calendar/icsFeeds.ts, on only for the literal
# `true`) gates `/api/mobile/calendar/ics/**` and the 30-minute refresh job
# (infra/scheduler.sh). It was set on neither service, so a build with the
# screen got 404 `feature_disabled` on every call and the owner's phone showed
# «Calendar links are not available in this version.» (2026-09-29).
#
# On in both environments: the owner decided on 2026-09-29 that production
# gets the same features as staging. The value stays written out on both, so
# an operator turns calendar links off with one value change.
#
# Every feed URL is sealed with `MAYBESITTER_KMS_KEY_NAME` (fieldEncryption,
# purpose `ics-url` per feed) before it is stored, and both services already
# carry that key, so turning this on needs no other variable. The server
# fetches the URL through `safeFetch` (https only, no private addresses) and no
# model reads a feed, so this is not a spending decision.
#
# ── M5a controls caller (#810) ──────────────────────────────────────────────
#
# `/api/internal/m5a-controls` (scripts/m5a-controls-init.ts, m5a-enable.ts and
# m5a-kill.ts) accepts one caller: the `maybesitter-deployer` service account,
# read from `MAYBESITTER_DEPLOYER_SA_EMAIL`. Nothing set it, so all three
# answered 503 `not_configured` on every environment and the incident kill in
# docs/operations/DEPLOY.md could not work; staging only had it by hand.
#
# It is here rather than in infra/scheduler.sh because, unlike the scheduler
# audience, it is static: the account name and the project id are both
# committed, so every deploy carries it and the two services cannot drift.
# `infra/scheduler.sh --check` reports it missing. The route also needs
# MAYBESITTER_INTERNAL_AUDIENCE, which scheduler.sh sets.
#
# Both environments, although M5a is off in production: the kill has to work
# wherever the controls exist, and the variable grants nothing by itself --
# only GitHub's Workload Identity can act as the deployer, unless a human is
# given a temporary token-creator role on it (see DEPLOY.md).
#
# ── Secrets ─────────────────────────────────────────────────────────────────
#
# Both services mount the same four Secret Manager secrets; the runtime SA
# has secretAccessor on each (checked 2026-09-29):
#   MAYBESITTER_DELETION_RECEIPT_PEPPER  deletion receipts, and the id of the
#                                        deletion tombstone first-time trust
#                                        creation reads (#794). Its version, and
#                                        MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS
#                                        while a rotation is active, come from
#                                        pepper-rotation.env (#798) -- never
#                                        rotate it outside the GCP_BOOTSTRAP.md
#                                        runbook;
#   MAYBESITTER_LLM_UID_SALT             salts the uid hash in model log lines
#                                        (lib/llm/llmLog.ts);
#   FOOTBALL_DATA_API_KEY                football fixtures (football-data.org).
#   MAYBESITTER_POSTPONE_SLOT_HMAC_KEY   signs short-lived postpone offers.
# The owner supplied the football credential on 2026-09-28 and first synced
# it on staging; production mounts it by the owner decision of 2026-09-29.
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
# whole flag stays one word with no spaces, since the workflow splits this
# script's output on whitespace (`read -ra`, #798).
# M5a activation precondition: the M5a revision must already serve 100 % of
# traffic for at least 10 minutes, then durable controls are enabled explicitly.
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
  "--update-env-vars=^;^MAYBESITTER_ENV=${env_name};MAYBESITTER_FEATURE_CAPTURE_KINDS=${capture_kinds};MAYBESITTER_KILL_SWITCH_CAPTURE_KINDS=false;MAYBESITTER_FEATURE_FREE_SLOTS=${free_slots};MAYBESITTER_KILL_SWITCH_FREE_SLOTS=false;MAYBESITTER_FEATURE_EXTERNAL_CLASH_HOLD=${m4b_features};MAYBESITTER_KILL_SWITCH_EXTERNAL_CLASH_HOLD=false;MAYBESITTER_FEATURE_EVENING_IMPACT=${m4b_features};MAYBESITTER_KILL_SWITCH_EVENING_IMPACT=false;MAYBESITTER_FEATURE_SMART_POSTPONE=${m4b_features};MAYBESITTER_KILL_SWITCH_SMART_POSTPONE=false;MAYBESITTER_FEATURE_PROACTIVE_LOOP=${proactive_loop};MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP=false;MAYBESITTER_FEATURE_CALENDAR_CHOICE=${m5a_features};MAYBESITTER_KILL_SWITCH_CALENDAR_CHOICE=false;MAYBESITTER_FEATURE_EMAIL_SOURCES=${m5a_features};MAYBESITTER_KILL_SWITCH_EMAIL_SOURCES=false;MAYBESITTER_FEATURE_MEMORY_LEARNING=${m5b_features};MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING=false;MAYBESITTER_FEATURE_SEARCH_HISTORY=${m6_features};MAYBESITTER_KILL_SWITCH_SEARCH_HISTORY=false;MAYBESITTER_FEATURE_MEMORY_TRANSLATION=${memory_translation};MAYBESITTER_KILL_SWITCH_MEMORY_TRANSLATION=false;MAYBESITTER_STORAGE_BACKEND=firestore;MAYBESITTER_FIRESTORE_DATABASE_ID=${database_id};GOOGLE_CLOUD_PROJECT=${PROJECT_ID};MAYBESITTER_LLM_PROVIDER=${llm_provider};MAYBESITTER_LLM_MODEL=gemini-2.5-flash;MAYBESITTER_VERTEX_LOCATION=${REGION};MAYBESITTER_GCP_PROJECT=${PROJECT_ID};MAYBESITTER_LLM_TIMEOUT_MS=8000;MAYBESITTER_LLM_MAX_RETRIES=1;MAYBESITTER_AI_DISABLED=${ai_disabled};MAYBESITTER_LLM_DAILY_CALL_CAP=60;MAYBESITTER_LLM_DAILY_TOKEN_CAP=150000;MAYBESITTER_LLM_MINUTE_CALL_CAP=8;MAYBESITTER_LLM_GLOBAL_DAILY_CALL_CAP=${global_daily_call_cap};MAYBESITTER_FEATURE_RECOMMENDATION=true;MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false;MAYBESITTER_NEXT_STEP_ARM=personalized;MAYBESITTER_FEATURE_MEMORY=${memory_feature};MAYBESITTER_KILL_SWITCH_MEMORY=${memory_kill_switch};MAYBESITTER_KMS_KEY_NAME=${KMS_KEY_NAME};ICS_FEEDS_ENABLED=${ics_feeds};SHARE_INTAKE_ENABLED=true;MAYBESITTER_DEPLOYER_SA_EMAIL=${DEPLOYER_SA};MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE=${pepper_write}${site_origins}" \
  "--set-secrets=${pepper_secrets},MAYBESITTER_LLM_UID_SALT=maybesitter-llm-uid-salt:latest,FOOTBALL_DATA_API_KEY=maybesitter-football-data-api-key:latest,MAYBESITTER_POSTPONE_SLOT_HMAC_KEY=maybesitter-postpone-slot-hmac-key:latest"
printf '\n'
