#!/usr/bin/env bash
# Prove the API needs no writable local filesystem (UC-1.9, #153).
#
# Cloud Run gives each instance an in-memory, per-instance filesystem: anything
# written there is lost on redeploy and invisible to every other instance. This
# runs the real image with a read-only root and only a small tmpfs, against the
# Firestore and Auth emulators. Any code path that still writes to disk fails
# with EROFS, turns into a 5xx, and fails this script — which is far cheaper
# than discovering it from a deployed service.
#
# Usage:
#   scripts/verify-readonly-container.sh                # build, run, probe
#   KEEP_RUNNING=1 scripts/verify-readonly-container.sh # leave it up to poke at
#
# Requires: docker, and the Firebase emulators reachable on the host
# (firebase emulators:start --only firestore,auth), plus JDK 21+ for those.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

IMAGE="${IMAGE:-maybesitter-api:readonly-check}"
CONTAINER="${CONTAINER:-maybesitter-readonly-check}"
PORT="${PORT:-8098}"
FIRESTORE_PORT="${FIRESTORE_PORT:-8080}"
AUTH_PORT="${AUTH_PORT:-9099}"

cleanup() {
  if [ "${KEEP_RUNNING:-}" = "1" ]; then
    echo "container ${CONTAINER} left running on :${PORT}"
    return
  fi
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building ${IMAGE}"
docker build --build-arg "GIT_SHA=readonly-check" -t "${IMAGE}" . >/dev/null

echo "==> starting it with a read-only root filesystem"
# `host.docker.internal` is how the container reaches the emulators on the host.
# Docker Desktop provides it, a Linux daemon does not, so on a CI runner the
# name did not resolve, the storage probe timed out, and readiness never came —
# a networking failure that looks exactly like a broken image. The explicit
# host-gateway mapping makes the two behave the same.
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
docker run -d --name "${CONTAINER}" \
  --read-only \
  --tmpfs /tmp:rw,size=16m \
  -p "${PORT}:8080" \
  --add-host "host.docker.internal:host-gateway" \
  -e MAYBESITTER_ENV=staging \
  -e MAYBESITTER_STORAGE_BACKEND=firestore \
  -e MAYBESITTER_FIRESTORE_DATABASE_ID=staging \
  -e GOOGLE_CLOUD_PROJECT=demo-maybesitter \
  -e "FIRESTORE_EMULATOR_HOST=host.docker.internal:${FIRESTORE_PORT}" \
  -e "FIREBASE_AUTH_EMULATOR_HOST=host.docker.internal:${AUTH_PORT}" \
  "${IMAGE}" >/dev/null

echo "==> waiting for readiness"
ready=""
for _ in $(seq 1 45); do
  if body="$(curl -fsS "http://localhost:${PORT}/api/health/ready" 2>/dev/null)"; then
    case "${body}" in *'"ready":true'*) ready="yes"; break ;; esac
  fi
  sleep 2
done

if [ -z "${ready}" ]; then
  echo "FAIL: the service never reported ready on a read-only filesystem"
  echo "--- last 40 log lines"
  docker logs "${CONTAINER}" 2>&1 | tail -40
  exit 1
fi

echo "==> health"
curl -fsS "http://localhost:${PORT}/api/health"
echo

echo "==> checking the logs for filesystem errors"
if docker logs "${CONTAINER}" 2>&1 | grep -qE "EROFS|read-only file system"; then
  echo "FAIL: something tried to write to the container filesystem"
  docker logs "${CONTAINER}" 2>&1 | grep -nE "EROFS|read-only file system" | head -10
  exit 1
fi

echo "==> the image writes nothing outside /tmp"
# Anything created under the app directory would be lost on the next instance.
if changed="$(docker diff "${CONTAINER}" | grep -vE '^C /(tmp|run|var/tmp)' || true)"; [ -n "${changed}" ]; then
  echo "FAIL: the container filesystem changed:"
  echo "${changed}" | head -20
  exit 1
fi

echo
echo "PASS: the API serves with a read-only root filesystem and writes nothing to disk"
