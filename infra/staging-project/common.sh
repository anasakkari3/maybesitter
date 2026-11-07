#!/usr/bin/env bash
# Shared names for the isolated staging project (Phase 5.8, Option A).
#
# Sourced by bootstrap.sh and verify-isolation.sh so the identities, pools and
# trust conditions that one creates are exactly the ones the other checks.
# Everything here is a function, so sourcing it defines nothing that runs.
#
# Nothing in this directory may ever act on the production project. The
# refusal lives here so both scripts apply the same rule.

# The production project. Hard-coded on purpose: these are the values the
# staging scripts must refuse, not configuration.
prod_project_id() { printf '%s' 'maybesitter-app'; }
prod_project_number() { printf '%s' '955684917741'; }

# GitHub repository identity. repository_id is stable across renames and
# transfers, unlike the owner/name string.
github_repository() { printf '%s' "${GITHUB_REPOSITORY_NAME:-anasakkari3/maybesitter}"; }
github_repository_id() { printf '%s' "${GITHUB_REPOSITORY_ID:-1205137389}"; }

# Service accounts (account ids; the email is <id>@<project>.iam.gserviceaccount.com).
sa_run() { printf '%s' 'staging-run'; }
sa_deploy_app() { printf '%s' 'staging-deploy-app'; }
sa_deploy_infra() { printf '%s' 'staging-deploy-infra'; }
sa_scheduler() { printf '%s' 'staging-scheduler'; }
sa_email() { printf '%s@%s.iam.gserviceaccount.com' "$1" "$2"; } # account id, project id

# Resources inside the staging project.
staging_service() { printf '%s' 'maybesitter-api-staging'; }
staging_artifact_repo() { printf '%s' 'maybesitter'; }
# The app refuses MAYBESITTER_ENV=staging on the (default) database
# (lib/storage/firestoreAdapter.ts), so staging keeps a database named
# `staging` in its own project too. firebase.staging-project.json names it.
staging_database() { printf '%s' 'staging'; }
# Same names as production, inside a different project: infra/cloudrun/flags.sh
# mounts secrets by name, and Cloud Run resolves a bare name in the service's
# own project. The VALUES are new and are never copied from production.
staging_secrets() {
  printf '%s\n' \
    maybesitter-deletion-receipt-pepper \
    maybesitter-llm-uid-salt \
    maybesitter-postpone-slot-hmac-key \
    maybesitter-football-data-api-key
}

# Workload Identity Federation. Two pools, one per workflow, because an IAM
# principalSet names a pool, not a provider: with one pool, any token the pool
# accepts could be bound to either service account. With two, the application
# workflow's token cannot even be exchanged in the pool that reaches the
# infrastructure identity, and the reverse.
wif_pool_app() { printf '%s' 'github-staging-app'; }
wif_pool_infra() { printf '%s' 'github-staging-infra'; }
wif_provider() { printf '%s' 'github-actions'; }
wif_attribute_mapping() {
  printf '%s' 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.environment=assertion.environment,attribute.ref=assertion.ref,attribute.job_workflow_ref=assertion.job_workflow_ref,attribute.sha=assertion.sha'
}
workflow_prefix() { # workflow file name
  printf '%s/.github/workflows/%s@' "$(github_repository)" "$1"
}
# The trust condition for each pool: the repository id, the protected
# `staging` GitHub environment, and exactly one workflow file. Their union is
#   assertion.repository_id=='<id>' && assertion.environment=='staging' &&
#   (job_workflow_ref starts with deploy-staging.yml@ || infra-staging.yml@)
# and each pool accepts only its own half of it.
wif_condition_for() { # workflow file name
  printf "assertion.repository_id=='%s' && assertion.environment=='staging' && assertion.job_workflow_ref.startsWith('%s')" \
    "$(github_repository_id)" "$(workflow_prefix "$1")"
}
wif_condition_app() { wif_condition_for deploy-staging.yml; }
wif_condition_infra() { wif_condition_for infra-staging.yml; }
wif_principal_set() { # project number, pool id
  printf 'principalSet://iam.googleapis.com/projects/%s/locations/global/workloadIdentityPools/%s/attribute.environment/staging' "$1" "$2"
}

# refuse_production_project ID [NUMBER]: exit 3 if either names production.
refuse_production_project() {
  local id="${1:-}" number="${2:-}"
  if [ -z "${id}" ]; then
    echo "REFUSED: no staging project id given" >&2
    exit 3
  fi
  if [ "${id}" = "$(prod_project_id)" ]; then
    echo "REFUSED: ${id} is the production project; these scripts only act on an isolated staging project" >&2
    exit 3
  fi
  if [ -n "${number}" ] && [ "${number}" = "$(prod_project_number)" ]; then
    echo "REFUSED: project number ${number} is production's" >&2
    exit 3
  fi
  case "${id}" in
    *[!a-z0-9-]* | [!a-z]*) echo "REFUSED: '${id}' is not a valid project id" >&2; exit 3 ;;
  esac
  if [ "${#id}" -lt 6 ] || [ "${#id}" -gt 30 ]; then
    echo "REFUSED: '${id}' is not 6-30 characters" >&2
    exit 3
  fi
}
