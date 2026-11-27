#!/usr/bin/env bash
# Fails CI if code breaks the code rules in docs/architecture.md, section 5.
# These are tripwires for the usual mistakes, not a full parser.
set -uo pipefail
cd "$(dirname "$0")/.."
status=0

# 1. SQL only through prepare(...).bind(...). No values pasted into SQL text:
#    no template strings with ${...} and no string concatenation inside prepare().
if grep -rnE 'prepare\(\s*`[^`]*\$\{' src; then
  echo "::error::SQL built with a template string inside prepare(). Use ? placeholders and .bind()."
  status=1
fi
if grep -rnE "prepare\([^)]*[\"'\`][[:space:]]*\+" src; then
  echo "::error::SQL built by string concatenation inside prepare(). Use ? placeholders and .bind()."
  status=1
fi

# 2. Page code writes data with textContent only, never as HTML.
if grep -rnE '\.(innerHTML|outerHTML)[[:space:]]*\+?=|insertAdjacentHTML|document\.write' src public; then
  echo "::error::HTML written from code. Use textContent and DOM methods instead."
  status=1
fi

# 3. Bookings are never written with INSERT OR IGNORE / OR REPLACE (they change how
#    the slot trigger handles conflicts).
if grep -rniE 'INSERT[[:space:]]+OR[[:space:]]+(IGNORE|REPLACE)|REPLACE[[:space:]]+INTO' src; then
  echo "::error::INSERT OR IGNORE / OR REPLACE / REPLACE INTO is not allowed."
  status=1
fi

[ "$status" -eq 0 ] && echo "Code rules: OK"
exit "$status"
