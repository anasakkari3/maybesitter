#!/usr/bin/env bash
# Fails if any signing material or service-account key is tracked by git
# (UC-1.6a #150 step 4).
#
# .gitignore is not a guarantee: a `git add -f`, or a pattern added after a
# file was already tracked, both leave it in the repository. This checks what
# git actually tracks, which is the only thing that matters.
set -euo pipefail

cd "$(dirname "$0")/.."

pattern='\.(jks|keystore|p8|p12|mobileprovision|cer|certSigningRequest)$|service-account|^credentials\.json$'

tracked="$(git ls-files | grep -E "$pattern" || true)"

if [ -n "$tracked" ]; then
  echo "Signing material is tracked by git. Remove it from history, rotate it, and keep it in EAS:" >&2
  echo "$tracked" >&2
  exit 1
fi

echo "No keystore, .p8, .p12, provisioning profile or service-account key is tracked."
