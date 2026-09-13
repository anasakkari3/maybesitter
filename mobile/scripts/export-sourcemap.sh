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
#
# Run by EAS Build itself: `eas-build-on-success` in package.json is the hook
# EAS invokes at the end of a successful build, from the project root — the
# same directory build/sourcemaps and eas.json are resolved against. It was
# missing until #180's follow-up, which meant the map was never produced and
# buildArtifactPaths collected an empty directory.
set -euo pipefail

# A development build ships a development client, not an embedded bundle, so
# there is nothing for this map to correspond to. Producing one anyway is the
# hazard this script's header warns about: a map from a different bundle
# symbolicates to the wrong lines and looks like an answer. The profile is only
# set inside EAS, so a hand-run `export-sourcemap.sh ios` still works.
if [ "${EAS_BUILD_PROFILE:-}" = "development" ]; then
  echo "development profile: no embedded bundle, so no source map to export."
  exit 0
fi

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
