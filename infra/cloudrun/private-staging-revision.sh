#!/usr/bin/env bash
# A private staging revision for QA (Wave D, lane D3).
#
# Deploys the image staging serves right now, with the full staging settings
# from flags.sh plus a few overrides, as a new revision of
# maybesitter-api-staging behind a `qa-<name>` tag and with NO traffic. Only
# requests sent to the tag URL reach it; the staging URL, its traffic and the
# Cloud Scheduler jobs (which call the service URL, never a tag: see
# infra/scheduler.sh) stay where they were.
#
# Runbook and the QA rows it opens: docs/operations/QA_PRIVATE_REVISION.md.
#
# Usage:
#   private-staging-revision.sh --name <name> [--set KEY=VALUE]... [--dry-run]
#   private-staging-revision.sh --remove qa-<name> [--dry-run]
#   private-staging-revision.sh --list
#
#   --name      the tag becomes qa-<name>: lowercase letters, digits and
#               hyphens, at most 20 characters.
#   --set       one environment override, applied after the staging settings
#               (it replaces the staging value, or is added if flags.sh does
#               not set the key). Repeatable; a key may appear once.
#   --remove    drops the tag. Traffic is never touched; the revision stays,
#               untagged and with no traffic.
#   --list      the qa-* tags on the service.
#   --dry-run   prints every command that would change something, runs only
#               the reads (`gcloud run services/revisions describe`).
#   --service   accepted only so a wrong service is refused by name; the one
#               allowed value is maybesitter-api-staging.
#
# PROJECT_ID and REGION are read as flags.sh reads them (defaults
# maybesitter-app, europe-west1). MAYBESITTER_FLAGS_* are passed through to
# flags.sh for the isolated staging project.
#
# What creating one does to the service, besides the tagged revision: a
# deploy rewrites the service template, so the next deploy (CI, or
# infra/scheduler.sh's `services update`) would start from the overrides. The
# script therefore deploys a second revision right after, again with
# --no-traffic and no tag, carrying the plain staging settings and removing
# any key the overrides added. The template is then what CI would produce.
#
# The private revision shares the staging Firestore database, Firebase Auth
# users and secrets. It can only be pointed at the staging database.
set -euo pipefail

STAGING_SERVICE="maybesitter-api-staging"
SERVICE="${STAGING_SERVICE}"
PROJECT_ID="${PROJECT_ID:-maybesitter-app}"
REGION="${REGION:-europe-west1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

refuse() { echo "refusing: $*" >&2; exit 2; }
fail() { echo "private-staging-revision: $*" >&2; exit 1; }
usage() { sed -n '/^# Usage:/,/^# PROJECT_ID/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//' >&2; exit 2; }

action=""
name=""
remove_tag=""
dry_run=0
override_keys=()
override_values=()

set_action() {
  [ -z "${action}" ] || refuse "--name, --remove and --list are exclusive"
  action="$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name) [ $# -ge 2 ] || usage; set_action create; name="$2"; shift 2 ;;
    --remove) [ $# -ge 2 ] || usage; set_action remove; remove_tag="$2"; shift 2 ;;
    --list) set_action list; shift ;;
    --set)
      [ $# -ge 2 ] || usage
      pair="$2"
      case "${pair}" in *=*) ;; *) refuse "--set ${pair}: expected KEY=VALUE" ;; esac
      key="${pair%%=*}"
      value="${pair#*=}"
      [[ "${key}" =~ ^[A-Z][A-Z0-9_]*$ ]] || refuse "--set ${pair}: the key must be an upper-case variable name"
      # The env list is one `;`-delimited word (flags.sh, `^;^`), split by
      # `read -ra`: a `;` would smuggle in a second variable, a space a second word.
      case "${value}" in *';'* | *' '* | *$'\t'* | *$'\n'*) refuse "--set ${key}: the value may not contain ';' or whitespace" ;; esac
      # What keeps this revision staging's, on staging's data, called only by
      # its own scheduler. Never overridable.
      case "${key}" in
        MAYBESITTER_ENV | MAYBESITTER_FIRESTORE_DATABASE_ID | MAYBESITTER_STORAGE_BACKEND | \
        GOOGLE_CLOUD_PROJECT | MAYBESITTER_GCP_PROJECT | MAYBESITTER_KMS_KEY_NAME | \
        MAYBESITTER_INTERNAL_AUDIENCE | MAYBESITTER_SCHEDULER_SA_EMAIL | MAYBESITTER_DEPLOYER_SA_EMAIL | \
        MAYBESITTER_DELETION_RECEIPT_PEPPER*)
          refuse "${key} is fixed to staging's value and cannot be overridden" ;;
      esac
      for existing in ${override_keys[@]+"${override_keys[@]}"}; do
        [ "${existing}" != "${key}" ] || refuse "--set ${key} is given twice"
      done
      override_keys+=("${key}")
      override_values+=("${value}")
      shift 2
      ;;
    --dry-run) dry_run=1; shift ;;
    --service) [ $# -ge 2 ] || usage; SERVICE="$2"; shift 2 ;;
    -h | --help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

# ── Refusals that need no network ───────────────────────────────────────────
[ "${SERVICE}" = "${STAGING_SERVICE}" ] \
  || refuse "${SERVICE} is not ${STAGING_SERVICE}; a private revision is for staging only, never production"
[ -n "${action}" ] || usage
if [ "${action}" != create ] && [ "${#override_keys[@]}" -gt 0 ]; then
  refuse "--set only goes with --name"
fi
case "${action}" in
  create)
    [[ "${name}" =~ ^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$ ]] \
      || refuse "--name ${name}: lowercase letters, digits and inner hyphens, 1-20 characters"
    TAG="qa-${name}"
    ;;
  remove)
    [[ "${remove_tag}" =~ ^qa-[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$ ]] \
      || refuse "--remove ${remove_tag}: only qa-* tags made by this script can be removed"
    TAG="${remove_tag}"
    ;;
esac
command -v jq >/dev/null 2>&1 || fail "jq is required"

run() {
  if [ "${dry_run}" = 1 ]; then
    printf 'DRY-RUN:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

describe_service() {
  gcloud run services describe "${SERVICE}" --region="${REGION}" --project="${PROJECT_ID}" --format=json
}

# ── --list ──────────────────────────────────────────────────────────────────
if [ "${action}" = list ]; then
  rows="$(describe_service | jq -r '.status.traffic[]? | select((.tag // "") | startswith("qa-"))
    | [.tag, (.revisionName // "-"), ((.percent // 0) | tostring) + "%", (.url // "-")] | @tsv')"
  if [ -z "${rows}" ]; then
    echo "no qa-* tags on ${SERVICE}"
  else
    printf 'TAG\tREVISION\tTRAFFIC\tURL\n%s\n' "${rows}"
  fi
  exit 0
fi

# ── --remove ────────────────────────────────────────────────────────────────
if [ "${action}" = remove ]; then
  service_json="$(describe_service)"
  entry="$(jq -c --arg tag "${TAG}" '[.status.traffic[]? | select(.tag == $tag)] | first // empty' <<<"${service_json}")"
  [ -n "${entry}" ] || refuse "${SERVICE} has no tag ${TAG} (see --list)"
  percent="$(jq -r '.percent // 0' <<<"${entry}")"
  [ "${percent}" = 0 ] || refuse "${TAG} carries ${percent}% of the traffic; this script never moves traffic"
  revision="$(jq -r '.revisionName // ""' <<<"${entry}")"
  # update-traffic with --remove-tags alone: the percentages are left as they are.
  run gcloud run services update-traffic "${SERVICE}" \
    --region="${REGION}" --project="${PROJECT_ID}" --remove-tags="${TAG}"
  echo "${TAG} removed. Revision ${revision} stays, with no tag and no traffic. To delete it as well:"
  echo "  gcloud run revisions delete ${revision} --region=${REGION} --project=${PROJECT_ID}"
  exit 0
fi

# ── create ──────────────────────────────────────────────────────────────────
# Its own assignment, so a refusal from flags.sh stops here (set -e).
FLAGS="$(bash "${SCRIPT_DIR}/flags.sh" staging)"
read -ra FLAG_WORDS <<<"${FLAGS}"

env_body=""
other_words=()
for word in "${FLAG_WORDS[@]}"; do
  case "${word}" in
    --update-env-vars=^\;^*) env_body="${word#--update-env-vars=^;^}" ;;
    --set-env-vars* | --clear-env-vars* | --env-vars-file* | --remove-env-vars* | --update-env-vars*)
      fail "flags.sh emitted ${word%%=*} in a form this script does not merge" ;;
    # The service is already public; a QA revision must not touch its IAM policy.
    --allow-unauthenticated) ;;
    --tag* | --no-traffic | --image*) fail "flags.sh emitted ${word%%=*}, which this script sets itself" ;;
    *) other_words+=("${word}") ;;
  esac
done
[ -n "${env_body}" ] || fail "flags.sh staging emitted no --update-env-vars=^;^ list"

# The staging settings, in order.
IFS=';' read -ra BASE_PAIRS <<<"${env_body}"
base_keys=()
base_values=()
for pair in "${BASE_PAIRS[@]}"; do
  base_keys+=("${pair%%=*}")
  base_values+=("${pair#*=}")
done

# The overrides, after them: a key flags.sh sets keeps its place and takes the
# new value; any other key is added at the end.
final_keys=("${base_keys[@]}")
final_values=("${base_values[@]}")
added_keys=()
i=0
while [ "${i}" -lt "${#override_keys[@]}" ]; do
  key="${override_keys[$i]}"
  found=0
  j=0
  while [ "${j}" -lt "${#final_keys[@]}" ]; do
    if [ "${final_keys[$j]}" = "${key}" ]; then
      final_values[$j]="${override_values[$i]}"
      found=1
    fi
    j=$((j + 1))
  done
  if [ "${found}" = 0 ]; then
    final_keys+=("${key}")
    final_values+=("${override_values[$i]}")
    added_keys+=("${key}")
  fi
  i=$((i + 1))
done

env_word() {
  # $1: name of the keys array, $2: name of the values array.
  local out="" k n
  eval "n=\${#$1[@]}"
  k=0
  while [ "${k}" -lt "${n}" ]; do
    local key value
    eval "key=\${$1[$k]}; value=\${$2[$k]}"
    out="${out}${out:+;}${key}=${value}"
    k=$((k + 1))
  done
  printf '%s' "--update-env-vars=^;^${out}"
}

value_of() {
  # $1: key; reads final_keys/final_values.
  local k=0
  while [ "${k}" -lt "${#final_keys[@]}" ]; do
    if [ "${final_keys[$k]}" = "$1" ]; then printf '%s' "${final_values[$k]}"; return 0; fi
    k=$((k + 1))
  done
  return 1
}

# Belt and braces: the keys are refused above, and flags.sh staging sets them.
[ "$(value_of MAYBESITTER_ENV || true)" = staging ] || refuse "the settings are not MAYBESITTER_ENV=staging"
[ "$(value_of MAYBESITTER_FIRESTORE_DATABASE_ID || true)" = staging ] \
  || refuse "the settings do not point at the staging database"

# The image staging serves: the revision holding 100 % of the traffic, by digest.
service_json="$(describe_service)"
serving="$(jq -r '[.status.traffic[]? | select((.percent // 0) == 100) | .revisionName // empty] | first // empty' <<<"${service_json}")"
[ -n "${serving}" ] || refuse "no single revision of ${SERVICE} holds 100% of the traffic (a rollout in progress?)"
service_url="$(jq -r '.status.url // empty' <<<"${service_json}")"
[ -n "${service_url}" ] || fail "${SERVICE} has no URL"
if jq -e --arg tag "${TAG}" '[.status.traffic[]? | select(.tag == $tag)] | length > 0' <<<"${service_json}" >/dev/null; then
  refuse "${TAG} already exists on ${SERVICE}; remove it first (--remove ${TAG}) or pick another name"
fi

revision_json="$(gcloud run revisions describe "${serving}" --region="${REGION}" --project="${PROJECT_ID}" --format=json)"
digest="$(jq -r '.status.imageDigest // empty' <<<"${revision_json}")"
if [ -z "${digest}" ]; then
  digest="$(jq -r '.spec.containers[0].image // empty' <<<"${revision_json}")"
fi
[[ "${digest}" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] \
  || fail "revision ${serving} reports no image digest (got '${digest}'); refusing to deploy by tag"

live_env() {
  jq -r --arg name "$1" '[.spec.containers[0].env[]? | select(.name == $name) | .value] | first // empty' <<<"${revision_json}"
}
[ "$(live_env MAYBESITTER_ENV)" = staging ] \
  || refuse "the serving revision ${serving} is not MAYBESITTER_ENV=staging"
[ "$(live_env MAYBESITTER_FIRESTORE_DATABASE_ID)" = staging ] \
  || refuse "the serving revision ${serving} is not on the staging database"

private_env="$(env_word final_keys final_values)"
base_env="$(env_word base_keys base_values)"

echo "service:   ${SERVICE} (${PROJECT_ID}, ${REGION})"
echo "serving:   ${serving}"
echo "image:     ${digest}"
echo "tag:       ${TAG} (no traffic)"
i=0
while [ "${i}" -lt "${#override_keys[@]}" ]; do
  echo "override:  ${override_keys[$i]}=${override_values[$i]}"
  i=$((i + 1))
done

# 1. The private revision.
run gcloud run deploy "${SERVICE}" \
  --image="${digest}" \
  --project="${PROJECT_ID}" \
  --no-traffic \
  --tag="${TAG}" \
  ${other_words[@]+"${other_words[@]}"} \
  "${private_env}"

# 2. The template back to plain staging, so no override reaches the next
#    deploy. No tag, no traffic.
reset_words=()
if [ "${#added_keys[@]}" -gt 0 ]; then
  added_csv="$(IFS=,; printf '%s' "${added_keys[*]}")"
  reset_words+=("--remove-env-vars=${added_csv}")
fi
run gcloud run deploy "${SERVICE}" \
  --image="${digest}" \
  --project="${PROJECT_ID}" \
  --no-traffic \
  ${other_words[@]+"${other_words[@]}"} \
  "${base_env}" \
  ${reset_words[@]+"${reset_words[@]}"}

if [ "${dry_run}" = 1 ]; then
  echo "tag URL (once deployed): https://${TAG}---${service_url#https://}"
else
  tag_url="$(describe_service | jq -r --arg tag "${TAG}" '[.status.traffic[]? | select(.tag == $tag) | .url] | first // empty')"
  [ -n "${tag_url}" ] || fail "deployed, but ${SERVICE} reports no URL for ${TAG}"
  echo "remove with: $0 --remove ${TAG}"
  echo "tag URL: ${tag_url}"
fi
