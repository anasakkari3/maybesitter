#!/usr/bin/env bash
# mobile/ is the React Native (Expo) app. The Flutter client is archived at the
# tag archive/flutter-final and must not come back — neither through a stale
# branch merged later nor through a restore of an old mobile/ path. This fails
# if any Flutter artefact is tracked under mobile/, if mobile/ is not the Expo
# app, or if a second RN app appears at mobile-rn/.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

flutter=$(git ls-files -- mobile | grep -E '\.dart$|(^|/)pubspec\.(yaml|lock)$|(^|/)\.metadata$|(^|/)analysis_options\.yaml$|^mobile/(ios|android)/' || true)
if [ -n "$flutter" ]; then
  echo "Flutter files are tracked under mobile/ (the Flutter client lives on archive/flutter-final):"
  echo "$flutter"
  exit 1
fi
if ! grep -q '"expo"' mobile/package.json 2>/dev/null; then
  echo "mobile/package.json is missing or does not depend on expo: mobile/ must be the React Native app."
  exit 1
fi
if [ -n "$(git ls-files -- mobile-rn)" ]; then
  echo "mobile-rn/ exists: the React Native app lives in mobile/, there is no second one."
  exit 1
fi
echo "mobile/ is the React Native app; no Flutter files, no mobile-rn/."
