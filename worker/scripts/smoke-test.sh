#!/usr/bin/env bash
# Checks the live site after a deploy: pages load and every security header is set.
# Usage: bash worker/scripts/smoke-test.sh https://club-booking.<subdomain>.workers.dev
set -euo pipefail

base="${1:?Usage: smoke-test.sh <site URL>}"
base="${base%/}"
failed=0

check() {
  local path="$1" expected_status="$2"
  local headers status
  headers="$(curl -sS -o /dev/null -D - --max-time 20 "${base}${path}")"
  status="$(printf '%s' "$headers" | head -1 | awk '{print $2}')"
  if [ "$status" != "$expected_status" ]; then
    echo "::error::${path}: expected HTTP ${expected_status}, got ${status}"
    failed=1
  fi
  for header in \
    "content-security-policy: default-src 'none'" \
    "strict-transport-security: max-age=" \
    "x-frame-options: DENY" \
    "x-content-type-options: nosniff" \
    "referrer-policy: no-referrer" \
    "permissions-policy:" \
    "cross-origin-opener-policy: same-origin" \
    "cross-origin-resource-policy: same-origin"; do
    if ! printf '%s' "$headers" | grep -qiF "$header"; then
      echo "::error::${path}: missing header '${header}'"
      failed=1
    fi
  done
  echo "${path}: HTTP ${status}"
}

check / 200
check /rules 200
check /api/health 200
check /no-such-page 404

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "Smoke test passed."
