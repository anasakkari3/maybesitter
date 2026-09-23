#!/usr/bin/env bash
#
# check-links.sh — verify the MaybeSitter public site.
#
# Two modes:
#
#   ./check-links.sh [BASE_URL]      HTTP mode (default BASE_URL http://localhost:8788)
#   ./check-links.sh --local         filesystem mode, no server needed (for CI)
#
# HTTP mode checks the 12 public pages (three landing pages, and privacy, terms and
# delete-account in three languages) and the 4 redirects (/privacy, /terms,
# /delete-account and /en). --local mode also scans every page for claims the
# approved claims policy forbids (docs/marketing/CLAIMS_POLICY.md).
#
# `cleanUrls` is a Firebase Hosting feature. A plain static file server (for
# example `python3 -m http.server`) does not implement it and does not implement
# the redirects either. The script therefore probes the server once to find out
# whether extensionless URLs resolve:
#
#   * clean URLs work   -> the URLs are checked exactly as deployed, and the two
#                          301 redirects are asserted over HTTP.
#   * clean URLs do not -> `.html` is appended so the same pages are still
#                          fetched and validated, and the redirect assertions are
#                          reported as SKIPPED (never as passed). The redirect
#                          *rules* are then verified in firebase-hosting.snippet.json
#                          instead, so a missing rule is still caught.
#
# Exit status is 0 only if every executed check passed.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SNIPPET="${SCRIPT_DIR}/firebase-hosting.snippet.json"

PASS=0
FAIL=0
SKIP=0

green() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
red()   { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
grey()  { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }

ok()      { PASS=$((PASS + 1)); green "$1"; }
bad()     { FAIL=$((FAIL + 1)); red "$1"; }
skipped() { SKIP=$((SKIP + 1)); grey "$1"; }

# The 12 public pages, as deployed (clean URLs, no extension).
PAGES=(
  "/:en:ltr"
  "/ar:ar:rtl"
  "/he:he:rtl"
  "/en/privacy:en:ltr"
  "/en/terms:en:ltr"
  "/en/delete-account:en:ltr"
  "/ar/privacy:ar:rtl"
  "/ar/terms:ar:rtl"
  "/ar/delete-account:ar:rtl"
  "/he/privacy:he:rtl"
  "/he/terms:he:rtl"
  "/he/delete-account:he:rtl"
)

# The 301 rules, as source:destination.
REDIRECTS=(
  "/privacy:/en/privacy"
  "/terms:/en/terms"
  "/delete-account:/en/delete-account"
  "/en:/"
)

# Map a deployed path to a path on a plain static file server.
as_static_path() {
  case "$1" in
    /) printf '/index.html' ;;
    /ar | /he) printf '%s/index.html' "$1" ;;
    *) printf '%s.html' "$1" ;;
  esac
}

# Map a deployed path to a file on disk, relative to site/.
as_disk_path() {
  case "$1" in
    /) printf '%s/index.html' "$SCRIPT_DIR" ;;
    /ar | /he) printf '%s%s/index.html' "$SCRIPT_DIR" "$1" ;;
    *) printf '%s%s.html' "$SCRIPT_DIR" "$1" ;;
  esac
}

# Pull the opening <html ...> tag out of a document.
html_tag() {
  tr '\n' ' ' <"$1" | grep -o '<html[^>]*>' | head -n 1 || true
}

# Validate lang and dir on the <html> tag of a file. $1 file, $2 label,
# $3 expected lang, $4 expected dir.
check_html_attrs() {
  local file="$1" label="$2" want_lang="$3" want_dir="$4" tag
  tag="$(html_tag "$file")"

  if [ -z "$tag" ]; then
    bad "${label} — no <html> tag found"
    return
  fi

  if printf '%s' "$tag" | grep -q "lang=\"${want_lang}\""; then
    ok "${label} — lang=\"${want_lang}\""
  else
    bad "${label} — expected lang=\"${want_lang}\" in: ${tag}"
  fi

  if printf '%s' "$tag" | grep -q "dir=\"${want_dir}\""; then
    ok "${label} — dir=\"${want_dir}\""
  else
    bad "${label} — expected dir=\"${want_dir}\" in: ${tag}"
  fi
}

# Assert every 301 rule exists in the hosting snippet (used when the local
# server cannot perform redirects, so the rule itself is still verified).
check_redirect_rules_in_snippet() {
  local src dst
  if [ ! -f "$SNIPPET" ]; then
    bad "firebase-hosting.snippet.json not found at ${SNIPPET}"
    return
  fi
  for pair in "${REDIRECTS[@]}"; do
    src="${pair%%:*}"
    dst="${pair##*:}"
    if tr -d ' \n' <"$SNIPPET" |
      grep -q "\"source\":\"${src}\",\"destination\":\"${dst}\",\"type\":301"; then
      ok "snippet declares 301 ${src} -> ${dst}"
    else
      bad "snippet is missing a 301 rule ${src} -> ${dst}"
    fi
  done
}

# Phrases the approved claims policy forbids on any public page, and phrases
# that are only forbidden on the landing pages (the privacy policy has to be able
# to name Google Calendar, Gmail scopes or voice processing to disclose them).
FORBIDDEN_EVERYWHERE=(
  "chief of staff"
  "personal AI"
  "AI assistant"
  "anonymous usage"
  "anonymous analytics"
  "Share anonymous"
  "at the right time"
  "بالوقت المناسب"
  "בזמן הנכון"
  "never forget"
  "knows you"
  "free forever"
  "\$5,000"
  "5,000 in"
)
FORBIDDEN_ON_LANDING=(
  "ADHD"
  "Gmail"
  "Outlook"
  "Todoist"
  "Notion"
  "WHOOP"
  "Google Calendar"
  "syllabus"
  "voice"
  "dialect"
  "بالصوت"
  "لهجة"
  "קולי"
  "Pro plan"
  "subscription"
  "aggregateRating"
  "reviewCount"
  "testimonial"
)

check_claims() {
  local phrase hits page
  for phrase in "${FORBIDDEN_EVERYWHERE[@]}"; do
    hits="$(grep -rilF --include='*.html' -e "$phrase" "$SCRIPT_DIR" || true)"
    if [ -n "$hits" ]; then
      bad "forbidden claim \"${phrase}\" in: $(printf '%s' "$hits" | tr '\n' ' ')"
    else
      ok "no \"${phrase}\""
    fi
  done
  for phrase in "${FORBIDDEN_ON_LANDING[@]}"; do
    hits=""
    for page in "${SCRIPT_DIR}/index.html" "${SCRIPT_DIR}/ar/index.html" "${SCRIPT_DIR}/he/index.html"; do
      if grep -qiF -e "$phrase" "$page"; then hits="${hits} ${page}"; fi
    done
    if [ -n "$hits" ]; then
      bad "landing pages must not claim \"${phrase}\":${hits}"
    else
      ok "landing pages: no \"${phrase}\""
    fi
  done
}

run_local() {
  echo "Mode: --local (filesystem, no server)"
  echo "Root: ${SCRIPT_DIR}"
  echo

  local entry path lang dir file
  for entry in "${PAGES[@]}"; do
    path="${entry%%:*}"
    lang="$(printf '%s' "$entry" | cut -d: -f2)"
    dir="$(printf '%s' "$entry" | cut -d: -f3)"
    file="$(as_disk_path "$path")"

    if [ ! -f "$file" ]; then
      bad "${path} — missing file ${file}"
      continue
    fi
    ok "${path} — file exists"
    check_html_attrs "$file" "$path" "$lang" "$dir"
  done

  # "/" is the English landing page; /en would duplicate it, so it only redirects.
  if [ -f "${SCRIPT_DIR}/en/index.html" ]; then
    bad "/en — en/index.html exists but /en must redirect to /"
  else
    ok "/en — no duplicate English landing page"
  fi

  local asset
  for asset in styles.css landing.css landing.js robots.txt sitemap.xml; do
    if [ -f "${SCRIPT_DIR}/${asset}" ]; then
      ok "${asset} — file exists"
    else
      bad "${asset} — missing"
    fi
  done

  echo
  echo "Claims (docs/marketing/CLAIMS_POLICY.md):"
  check_claims

  echo
  echo "Redirects (no server in --local mode; verifying the hosting rules instead):"
  check_redirect_rules_in_snippet
}

run_http() {
  local base="$1"
  base="${base%/}"

  echo "Mode: HTTP against ${base}/"
  echo

  local tmp status probe clean_urls
  tmp="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '${tmp}'" EXIT

  # Probe: does this server resolve extensionless URLs (cleanUrls)?
  probe="$(curl -s -o /dev/null -w '%{http_code}' "${base}/en/privacy" || true)"
  if [ "$probe" = "200" ]; then
    clean_urls=1
    echo "cleanUrls: yes (extensionless URLs resolve) — checking URLs as deployed"
  else
    clean_urls=0
    echo "cleanUrls: no (got HTTP ${probe} for /en/privacy) — appending .html"
    echo "           this is expected for a plain static file server."
  fi
  echo

  local entry path lang dir url
  for entry in "${PAGES[@]}"; do
    path="${entry%%:*}"
    lang="$(printf '%s' "$entry" | cut -d: -f2)"
    dir="$(printf '%s' "$entry" | cut -d: -f3)"

    if [ "$clean_urls" -eq 1 ]; then
      url="${base}${path}"
    else
      url="${base}$(as_static_path "$path")"
    fi

    status="$(curl -s -o "$tmp" -w '%{http_code}' "$url" || true)"
    if [ "$status" = "200" ]; then
      ok "${url} — 200"
      check_html_attrs "$tmp" "$path" "$lang" "$dir"
    else
      bad "${url} — expected 200, got ${status}"
    fi
  done

  echo
  echo "Redirects:"
  if [ "$clean_urls" -eq 1 ]; then
    local src dst location
    for pair in "${REDIRECTS[@]}"; do
      src="${pair%%:*}"
      dst="${pair##*:}"
      status="$(curl -s -o /dev/null -w '%{http_code}' "${base}${src}" || true)"
      location="$(curl -s -o /dev/null -w '%{redirect_url}' "${base}${src}" || true)"
      if [ "$status" = "301" ]; then
        ok "${src} — 301"
      else
        bad "${src} — expected 301, got ${status}"
      fi
      case "$location" in
        *"${dst}") ok "${src} — location ${location}" ;;
        *) bad "${src} — expected location ending in ${dst}, got '${location}'" ;;
      esac
    done
  else
    local pair
    for pair in "${REDIRECTS[@]}"; do
      skipped "${pair%%:*} — 301 not testable on a static file server"
    done
    echo "  Verifying the redirect rules in the hosting snippet instead:"
    check_redirect_rules_in_snippet
  fi
}

main() {
  local mode="http" base="http://localhost:8788"

  case "${1:-}" in
    --local) mode="local" ;;
    -h | --help)
      sed -n '2,30p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    "") ;;
    *) base="$1" ;;
  esac

  echo "MaybeSitter site check"
  echo "======================"

  if [ "$mode" = "local" ]; then
    run_local
  else
    run_http "$base"
  fi

  echo
  echo "----------------------"
  printf 'passed: %d   failed: %d   skipped: %d\n' "$PASS" "$FAIL" "$SKIP"

  if [ "$FAIL" -gt 0 ]; then
    echo "RESULT: FAIL"
    exit 1
  fi
  echo "RESULT: PASS"
}

main "$@"
