#!/usr/bin/env bash
# Keep the JS source map for the bundle this build embedded (UC-4.4, #180).
#
# Crashlytics shows Hermes frames minified. Without the map for *this exact
# build* a JS stack is a list of offsets, and the crash-free-sessions number it
# feeds is one nobody can act on.
#
# Exported here rather than committed, because it is per-build: the same source
# at a different commit produces a different map, and a map from the wrong
# build symbolicates to the wrong lines — worse than no map, because it looks
# like an answer.
#
# EAS collects build/sourcemaps as a private build artifact
# (buildArtifactPaths in eas.json). Symbolicate during triage with:
#
#   npx metro-symbolicate build/sourcemaps/<platform>.jsbundle.map < stack.txt
set -euo pipefail

PLATFORM="${EAS_BUILD_PLATFORM:-${1:-}}"
if [ -z "${PLATFORM}" ]; then
  echo "usage: export-sourcemap.sh <ios|android>  (or set EAS_BUILD_PLATFORM)" >&2
  exit 2
fi

mkdir -p build/sourcemaps

# --dev false and the production env, so the exported bundle is the one the
# binary embedded. A map produced from a development bundle maps nothing.
npx expo export:embed \
  --platform "${PLATFORM}" \
  --dev false \
  --bundle-output "build/sourcemaps/${PLATFORM}.jsbundle" \
  --sourcemap-output "build/sourcemaps/${PLATFORM}.jsbundle.map"

# The bundle is not worth keeping: it is already inside the binary, and it is
# large. The map is the part triage needs.
rm -f "build/sourcemaps/${PLATFORM}.jsbundle"

echo "source map written to build/sourcemaps/${PLATFORM}.jsbundle.map"
