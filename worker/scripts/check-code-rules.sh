#!/usr/bin/env bash
# Fails CI if code breaks the code rules in docs/architecture.md, section 5.
# These are tripwires for the usual mistakes, not a full parser.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
status=0

# 1. SQL only through prepare(...).bind(...). No values pasted into SQL text:
#    no template strings with ${...} (on one line or spread over several) and no
#    string concatenation inside prepare().
if grep -rlPz 'prepare\(\s*`[^`]*\$\{' src; then
  echo "::error::SQL built with a template string inside prepare() (files above). Use ? placeholders and .bind()."
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

# 4. Pages work under the strict CSP: no inline scripts, inline styles, inline event
#    handlers or javascript: links.
if grep -rnoE '<script[^>]*>' public --include='*.html' | grep -v 'src='; then
  echo "::error::Inline <script> in a page. Put the code in a .js file under public/js/."
  status=1
fi
if grep -rniE '<[a-z]+[^>]*[[:space:]](style|on[a-z]+)=' public --include='*.html'; then
  echo "::error::Inline style= or on...= attribute in a page. Use styles.css and addEventListener."
  status=1
fi
if grep -rniE 'javascript:' public; then
  echo "::error::javascript: link found."
  status=1
fi

# 5. No third-party scripts or files, except Turnstile (loaded only while the alarm is on).
#    (The SVG namespace address in favicon.svg is a name, never fetched.)
if grep -rnoE 'https?://[a-z0-9./-]+' public | grep -vE 'https://challenges\.cloudflare\.com|http://www\.w3\.org/2000/svg'; then
  echo "::error::Third-party address in a page or script. Only Turnstile (challenges.cloudflare.com) is allowed."
  status=1
fi

[ "$status" -eq 0 ] && echo "Code rules: OK"
exit "$status"
