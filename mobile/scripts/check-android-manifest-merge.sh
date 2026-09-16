#!/usr/bin/env bash
# Verifies Expo CNG prebuild and Android Manifest Merger (:app:processDebugMainManifest)
# to prevent regression of #458 (Firebase channel collision, minSdk 26, receiver duplicates).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(dirname "$SCRIPT_DIR")"

cd "$MOBILE_DIR"

echo "1. Prebuilding Android project (CNG clean)..."
npx expo prebuild --platform android --clean >/dev/null

echo "2. Running Android Manifest Merger (:app:processDebugMainManifest)..."
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_HOME

cd android
./gradlew :app:processDebugMainManifest --quiet

echo "3. Inspecting merged AndroidManifest.xml..."
MERGED_MANIFEST="app/build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml"

if [ ! -f "$MERGED_MANIFEST" ]; then
  echo "FAIL: Merged AndroidManifest.xml missing at $MERGED_MANIFEST" >&2
  exit 1
fi

failures=0
fail() { echo "  FAIL  $1" >&2; failures=$((failures + 1)); }
pass() { echo "  ok    $1"; }

grep -q 'package="com.maybesitter.app"' "$MERGED_MANIFEST" \
  && pass 'package is com.maybesitter.app' \
  || fail 'package is not com.maybesitter.app'

grep -q 'minSdkVersion="26"' "$MERGED_MANIFEST" \
  && pass 'minSdkVersion is 26' \
  || fail 'minSdkVersion is not 26'

grep -q 'com.google.firebase.messaging.default_notification_channel_id' "$MERGED_MANIFEST" \
  && pass 'Firebase default channel meta-data is present' \
  || fail 'Firebase default channel meta-data missing'

grep -q 'SCHEDULE_EXACT_ALARM' "$MERGED_MANIFEST" \
  && pass 'SCHEDULE_EXACT_ALARM permission present' \
  || fail 'SCHEDULE_EXACT_ALARM permission missing'

grep -q 'com.maybesitter.app.widget.NextStep' "$MERGED_MANIFEST" \
  && pass 'NextStep AppWidget receiver present' \
  || fail 'NextStep AppWidget receiver missing'

if [ "$failures" -gt 0 ]; then
  echo "Android manifest verification failed with $failures error(s)." >&2
  exit 1
fi

echo "Android manifest merger verification passed successfully."
