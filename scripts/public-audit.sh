#!/bin/bash
# Public-repo audit: things that must never reach a public repository. Exits non-zero on any hit.
# Checks tracked files, commit metadata and full history. A local, untracked denylist of private
# names may be supplied via PRIVACY_DENYLIST=<file> (one POSIX extended regex per line); it is never committed.
set -u
fail=0
note() { printf '%s\n' "$1"; fail=1; }

# Scan errors (a malformed regex, an unreadable/missing file, ...) are never
# allowed to read as "no hits": tracked apart from findings so any of them
# fails the audit even when nothing was actually flagged. Recorded to a real
# file, not a shell variable: scan_xargs_grep below runs as the producer
# side of a `$( )` command substitution in every call site, which forks a
# subshell -- a plain `errors=$((errors+1))` there would silently vanish
# once that subshell exits. A file survives the fork; its size, read once at
# the very end, is the real error count.
error_log="$(mktemp)"
trap 'rm -f "$error_log"' EXIT
error_out() { printf 'x' >> "$error_log"; printf 'ERROR public-audit: %s\n' "$1" >&2; }

# Runs `xargs -0 grep <args>` against the NUL-delimited path list on stdin --
# git ls-files -z paired with xargs -0 throughout this script so a filename
# with a space or a quote is never split or dropped. grep's ordinary "no
# match" is silent (empty stderr) and not an error; anything that writes to
# stderr -- a malformed regex, an unreadable or missing file, an argument
# list the OS refused, ... -- is a hard scan error. Exit status is not the
# signal here: xargs collapses grep's exit 1 ("no match") and exit 2 ("real
# error") into the same aggregate status when it batches multiple grep
# invocations, so stderr content is the only reliable signal.
scan_xargs_grep() {
  local outfile errfile
  outfile="$(mktemp)"; errfile="$(mktemp)"
  xargs -0 -r grep "$@" >"$outfile" 2>"$errfile"
  if [ -s "$errfile" ]; then
    error_out "grep failed for: $*"
    sed 's/^/  /' "$errfile" >&2
  else
    cat "$outfile"
  fi
  rm -f "$outfile" "$errfile"
}

# Validates one denylist expression with a dry match against empty input:
# exit 1 (no match) means the regex compiled; any other exit code means it
# is malformed. Called once per expression, never once per file.
validate_pattern() {
  printf '' | grep -qE -- "$1" 2>/dev/null
  local status=$?
  if [ "$status" -gt 1 ]; then
    error_out "invalid denylist expression, skipped: $1"
    return 1
  fi
  return 0
}

cd "$(git rev-parse --show-toplevel)"

# 1. committed archives and binaries -- a pure pathspec match, not a grep
# call, so there is no filename-splitting or exit-status question here.
archives="$(git ls-files -z -- '*.tgz' '*.tar.gz' '*.zip' '*.dmg' '*.pkg' | tr '\0' ' ')"
[ -n "$archives" ] && note "archive tracked: $archives"

# 2. commit identities that are not GitHub noreply addresses
bad_mail=$(git log --format='%ae%n%ce' | sort -u | grep -v -E '@users\.noreply\.github\.com$' || true)
[ -n "$bad_mail" ] && note "personal email in commit metadata: $bad_mail"

# 3. generic PII patterns in tracked files (POSIX ERE only; allowed placeholders filtered out afterwards)
pat='([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,})|(/Users/[a-z][a-z0-9_-]+)|(/home/[a-z][a-z0-9_-]+)|(\b10\.[0-9]+\.[0-9]+\.[0-9]+\b)|(\b192\.168\.[0-9]+\.[0-9]+\b)|(\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+\b)|(\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+\b)'
allow='@example\.com|@users\.noreply\.github\.com|/Users/(you|test|user|example|runner)\b|/home/(you|test|user|example|runner)\b|10\.0\.0\.[0-9]+'
hits=$(git ls-files -z -- . ':!LICENSE' ':!package.json' ':!package-lock.json' ':!scripts/public-audit.sh' \
  | scan_xargs_grep -n -E "$pat" | grep -v -E "$allow" || true)
[ -n "$hits" ] && note "PII pattern in tracked files:"$'\n'"$hits"

# 4. agent and process residue words in tracked files (case-sensitive words that only appear as residue)
res=$(git ls-files -z -- . ':!CHANGELOG.md' ':!scripts/public-audit.sh' ':!.privacy-denylist' \
  | scan_xargs_grep -n -w -E 'Co-Authored-By|Claude-Session|the fleet pace machine|slice [0-9]+' || true)
[ -n "$res" ] && note "process residue in tracked files:"$'\n'"$res"

# 5. optional local denylist across tracked files AND full history
PRIVACY_DENYLIST="${PRIVACY_DENYLIST:-$HOME/.config/headroom-privacy-denylist}"
if [ -f "$PRIVACY_DENYLIST" ]; then
  if [ ! -r "$PRIVACY_DENYLIST" ]; then
    error_out "PRIVACY_DENYLIST is present but unreadable: $PRIVACY_DENYLIST"
  else
    while IFS= read -r rx; do
      [ -z "$rx" ] && continue; case "$rx" in \#*) continue;; esac
      validate_pattern "$rx" || continue
      f=$(git ls-files -z -- . ':!LICENSE' ':!package.json' ':!.privacy-denylist' ':!scripts/public-audit.sh' \
        | scan_xargs_grep -n -E "$rx" || true)
      [ -n "$f" ] && note "denylist hit in files ($rx):"$'\n'"$f"
      h=$(git log -p --all | grep -c -E "$rx" || true); [ "${h:-0}" -gt 0 ] && note "denylist hit in history ($rx): $h lines"
    done < "$PRIVACY_DENYLIST"
  fi
fi

errors=$(wc -c < "$error_log" | tr -d ' ')
if [ "$fail" = 0 ] && [ "$errors" = 0 ]; then
  echo "public-audit: PASS"
else
  [ "$errors" -gt 0 ] && echo "public-audit: $errors scan error(s) above (never treated as a clean pass)" >&2
  echo "public-audit: FAIL"
  exit 1
fi
