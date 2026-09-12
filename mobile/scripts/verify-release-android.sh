#!/usr/bin/env bash
# Checks an Android App Bundle against the things UC-1.6a (#150) requires,
# before it reaches a tester.
#
# Every one of these has shipped wrong in a real project: a debug-signed
# release (the retired Flutter client did exactly that), a missing INTERNET
# permission in the merged manifest, and backup left on so the user's data was
# copied to another device where it could not be decrypted.
#
# Usage: npm run verify:release-android -- path/to/app.aab
set -euo pipefail

AAB="${1:-}"
if [ -z "$AAB" ] || [ ! -f "$AAB" ]; then
  echo "usage: $0 <path-to-aab>" >&2
  exit 2
fi

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1" >&2; exit 2; }
}
need bundletool
need keytool

failures=0
fail() { echo "  FAIL  $1" >&2; failures=$((failures + 1)); }
pass() { echo "  ok    $1"; }

manifest="$(bundletool dump manifest --bundle "$AAB")"

echo "Manifest:"
grep -q 'package="com.maybesitter.app"' <<<"$manifest" \
  && pass 'package is com.maybesitter.app' \
  || fail 'package is not com.maybesitter.app'

grep -q 'android.permission.INTERNET' <<<"$manifest" \
  && pass 'INTERNET is requested' \
  || fail 'INTERNET is missing from the merged manifest'

grep -q 'android:allowBackup="false"' <<<"$manifest" \
  && pass 'allowBackup is false' \
  || fail 'allowBackup is not false'

grep -q 'android:dataExtractionRules' <<<"$manifest" \
  && pass 'dataExtractionRules is set' \
  || fail 'dataExtractionRules is missing (Android 12+ device transfer is a separate channel)'

for blocked in SYSTEM_ALERT_WINDOW READ_EXTERNAL_STORAGE WRITE_EXTERNAL_STORAGE; do
  grep -q "android.permission.$blocked" <<<"$manifest" \
    && fail "$blocked is requested and should be blocked" \
    || pass "$blocked is not requested"
done

echo "Signature:"
cert="$(keytool -printcert -jarfile "$AAB" 2>/dev/null || true)"
if [ -z "$cert" ]; then
  fail 'the bundle carries no signature'
elif grep -qi 'CN=Android Debug' <<<"$cert"; then
  # The exact defect the retired Flutter client shipped.
  fail 'the bundle is DEBUG-signed'
else
  pass 'signed with a non-debug certificate'
  grep -E 'Owner:|SHA1:|SHA256:' <<<"$cert" | sed 's/^/        /'
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed." >&2
  exit 1
fi
echo "All release checks passed."
