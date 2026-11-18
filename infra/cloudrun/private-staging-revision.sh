#!/usr/bin/env bash
# A private staging revision for QA (Wave D, lane D3).
#
# Deploys the image staging serves right now, with the service template's
# settings plus a few overrides, as a new revision of
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
#   --set       one environment override, applied over the template's env
#               (it replaces the template value, or is added if the template
#               does not set the key). Repeatable; a key may appear once.
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
# flags.sh, which is only compared against the template (a warning per
# difference); the template, not flags.sh, is what gets deployed and restored.
#
# Refused: traffic that follows the latest revision (a deploy would move it),
# and pinned traffic that does not add up to 100 %.
#
# What creating one does to the service, besides the tagged revision: a
# deploy rewrites the service template, so the next deploy (CI, or
# infra/scheduler.sh's `services update`) would start from the overrides. The
# script therefore deploys a second revision right after, again with
# --no-traffic and no tag, with the template's original image and env exactly,
# removing any key the overrides added. If that restore fails, or the run is
# interrupted after the first deploy, it is tried once more: exit 4 when it
# then succeeds, exit 3 with the ready command when it does not.
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
if [ "${action}" != create ] && [ "${#override_keys[@]}" -gt 0 ]; then
  refuse "--set only goes with --name"
fi
[ -n "${action}" ] || usage
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
service_json="$(describe_service)"

# Traffic must be pinned to named revisions adding up to 100 %. Traffic that
# follows the latest revision would move to whatever this script deploys.
if jq -e '[(.spec.traffic // [])[], (.status.traffic // [])[] | select(.latestRevision == true)] | length > 0' \
  <<<"${service_json}" >/dev/null; then
  refuse "${SERVICE}'s traffic follows the latest revision, so a deploy would move it. Pin it first: gcloud run services update-traffic ${SERVICE} --region=${REGION} --project=${PROJECT_ID} --to-revisions=<serving revision>=100"
fi
pinned_sum="$(jq '[.status.traffic[]? | select(.revisionName != null) | (.percent // 0)] | add // 0' <<<"${service_json}")"
[ "${pinned_sum}" = 100 ] || refuse "${SERVICE}'s pinned traffic adds up to ${pinned_sum}%, not 100%"
serving="$(jq -r '[.status.traffic[]? | select((.percent // 0) == 100) | .revisionName // empty] | first // empty' <<<"${service_json}")"
[ -n "${serving}" ] || refuse "no single revision of ${SERVICE} holds 100% of the traffic (a rollout in progress?)"
service_url="$(jq -r '.status.url // empty' <<<"${service_json}")"
[ -n "${service_url}" ] || fail "${SERVICE} has no URL"
if jq -e --arg tag "${TAG}" '[.status.traffic[]? | select(.tag == $tag)] | length > 0' <<<"${service_json}" >/dev/null; then
  refuse "${TAG} already exists on ${SERVICE}; remove it first (--remove ${TAG}) or pick another name"
fi

# The original template: its image and its plain env values, in order.
# Secret-backed variables (valueFrom) are not env values and are left alone.
template_image="$(jq -r '.spec.template.spec.containers[0].image // empty' <<<"${service_json}")"
[ -n "${template_image}" ] || fail "${SERVICE}'s template has no image"
bad_value="$(jq -r '[.spec.template.spec.containers[0].env[]? | select(.valueFrom == null)
  | select((.value // "") | test("[;\\s]")) | .name] | first // empty' <<<"${service_json}")"
[ -z "${bad_value}" ] || refuse "the template value of ${bad_value} contains ';' or whitespace, which the env list cannot carry"
base_keys=()
base_values=()
while IFS= read -r pair; do
  [ -n "${pair}" ] || continue
  base_keys+=("${pair%%=*}")
  base_values+=("${pair#*=}")
done < <(jq -r '.spec.template.spec.containers[0].env[]? | select(.valueFrom == null) | "\(.name)=\(.value // "")"' <<<"${service_json}")
[ "${#base_keys[@]}" -gt 0 ] || fail "${SERVICE}'s template has no env values"

base_value_of() {
  local k=0
  while [ "${k}" -lt "${#base_keys[@]}" ]; do
    if [ "${base_keys[$k]}" = "$1" ]; then printf '%s' "${base_values[$k]}"; return 0; fi
    k=$((k + 1))
  done
  return 1
}
[ "$(base_value_of MAYBESITTER_ENV || true)" = staging ] \
  || refuse "the service template is not MAYBESITTER_ENV=staging"
[ "$(base_value_of MAYBESITTER_FIRESTORE_DATABASE_ID || true)" = staging ] \
  || refuse "the service template is not on the staging database"

# The template is used as it is. flags.sh staging is what CI would deploy; if
# the two disagree, say so (the restore still puts back the template, not flags.sh).
FLAGS="$(bash "${SCRIPT_DIR}/flags.sh" staging)"
read -ra FLAG_WORDS <<<"${FLAGS}"
for word in "${FLAG_WORDS[@]}"; do
  case "${word}" in
    --update-env-vars=^\;^*)
      IFS=';' read -ra FLAG_PAIRS <<<"${word#--update-env-vars=^;^}"
      for pair in "${FLAG_PAIRS[@]}"; do
        key="${pair%%=*}"
        want="${pair#*=}"
        if ! have="$(base_value_of "${key}")"; then
          echo "warning: the service template differs from flags.sh staging: ${key} is missing (flags.sh=${want})" >&2
        elif [ "${have}" != "${want}" ]; then
          echo "warning: the service template differs from flags.sh staging: ${key}=${have} (flags.sh=${want})" >&2
        fi
      done
      ;;
  esac
done

# The QA settings: the template's, then the overrides. A key the template has
# keeps its place and takes the new value; any other key is added at the end.
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
  local out="" k n key value
  eval "n=\${#$1[@]}"
  k=0
  while [ "${k}" -lt "${n}" ]; do
    eval "key=\${$1[$k]}; value=\${$2[$k]}"
    out="${out}${out:+;}${key}=${value}"
    k=$((k + 1))
  done
  printf '%s' "--update-env-vars=^;^${out}"
}

# The image staging serves: the revision holding 100 % of the traffic, by digest.
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

echo "service:   ${SERVICE} (${PROJECT_ID}, ${REGION})"
echo "serving:   ${serving}"
echo "image:     ${digest}"
echo "tag:       ${TAG} (no traffic)"
i=0
while [ "${i}" -lt "${#override_keys[@]}" ]; do
  echo "override:  ${override_keys[$i]}=${override_values[$i]}"
  i=$((i + 1))
done

# Only the image, the tag and the env change; every other setting (identity,
# resources, secrets, probes) stays as the template has it.
private_cmd=(gcloud run deploy "${SERVICE}"
  --image="${digest}" --region="${REGION}" --project="${PROJECT_ID}"
  --no-traffic --tag="${TAG}"
  "$(env_word final_keys final_values)")

# The restore: the template's own image and env, exactly; keys the overrides
# added are removed. No tag, no traffic.
restore_cmd=(gcloud run deploy "${SERVICE}"
  --image="${template_image}" --region="${REGION}" --project="${PROJECT_ID}"
  --no-traffic
  "$(env_word base_keys base_values)")
if [ "${#added_keys[@]}" -gt 0 ]; then
  restore_cmd+=("--remove-env-vars=$(IFS=,; printf '%s' "${added_keys[*]}")")
fi

# Called when the restore failed or the run was interrupted after the private
# deploy changed the template: one more restore, then a clear exit.
#   exit 4: the template was restored; the private revision may exist.
#   exit 3: the template still carries the overrides; the command is printed.
on_abort() {
  trap - ERR INT TERM
  echo "private-staging-revision: interrupted or failed after deploying ${TAG}; restoring the service template once more" >&2
  if run "${restore_cmd[@]}"; then
    echo "private-staging-revision: template restored. ${TAG} may exist; check with --list, remove with --remove ${TAG}" >&2
    exit 4
  fi
  echo "private-staging-revision: the restore failed. The service template still carries the QA overrides; run this before any other deploy:" >&2
  printf '  ' >&2
  printf '%q ' "${restore_cmd[@]}" >&2
  printf '\n' >&2
  exit 3
}

# 1. The private revision. If it fails, the template was not changed.
run "${private_cmd[@]}"

# 2. The restore, guarded: from here on any failure or interrupt restores.
trap on_abort ERR INT TERM
if ! run "${restore_cmd[@]}"; then
  on_abort
fi
trap - ERR INT TERM

if [ "${dry_run}" = 1 ]; then
  echo "tag URL (once deployed): https://${TAG}---${service_url#https://}"
else
  tag_url="$(describe_service | jq -r --arg tag "${TAG}" '[.status.traffic[]? | select(.tag == $tag) | .url] | first // empty')"
  [ -n "${tag_url}" ] || fail "deployed, but ${SERVICE} reports no URL for ${TAG}"
  echo "remove with: $0 --remove ${TAG}"
  echo "tag URL: ${tag_url}"
fi
