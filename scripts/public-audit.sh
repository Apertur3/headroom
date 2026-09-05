#!/bin/bash
# Public-repo audit: things that must never reach a public repository. Exits non-zero on any hit.
# Checks tracked files, commit metadata and full history. A local, untracked denylist of private
# names may be supplied via PRIVACY_DENYLIST=<file> (one POSIX extended regex per line); it is never committed.
set -u
fail=0
note() { printf '%s\n' "$1"; fail=1; }
cd "$(git rev-parse --show-toplevel)"
# 1. committed archives and binaries
if git ls-files | grep -E '\.(tgz|tar\.gz|zip|dmg|pkg)$' >/dev/null; then note "archive tracked: $(git ls-files | grep -E '\.(tgz|tar\.gz|zip|dmg|pkg)$' | tr '\n' ' ')"; fi
# 2. commit identities that are not GitHub noreply addresses
bad_mail=$(git log --format='%ae%n%ce' | sort -u | grep -v -E '@users\.noreply\.github\.com$' || true)
[ -n "$bad_mail" ] && note "personal email in commit metadata: $bad_mail"
# 3. generic PII patterns in tracked files (POSIX ERE only; allowed placeholders filtered out afterwards)
pat='([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,})|(/Users/[a-z][a-z0-9_-]+)|(/home/[a-z][a-z0-9_-]+)|(\b10\.[0-9]+\.[0-9]+\.[0-9]+\b)|(\b192\.168\.[0-9]+\.[0-9]+\b)|(\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+\b)|(\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+\b)'
allow='@example\.com|@users\.noreply\.github\.com|/Users/(you|test|user|example|runner)\b|/home/(you|test|user|example|runner)\b|10\.0\.0\.[0-9]+'
hits=$(git ls-files | grep -v -E '^(LICENSE|package(-lock)?\.json|scripts/public-audit\.sh)$' | xargs grep -n -E "$pat" 2>/dev/null | grep -v -E "$allow" || true)
[ -n "$hits" ] && note "PII pattern in tracked files:"$'\n'"$hits"
# 4. agent and process residue words in tracked files (case-sensitive words that only appear as residue)
res=$(git ls-files | xargs grep -n -w -E 'Co-Authored-By|Claude-Session|the fleet pace machine|slice [0-9]+' 2>/dev/null | grep -v -E '^(CHANGELOG\.md|scripts/public-audit\.sh|\.privacy-denylist)' || true)
[ -n "$res" ] && note "process residue in tracked files:"$'\n'"$res"
# 5. optional local denylist across tracked files AND full history
PRIVACY_DENYLIST="${PRIVACY_DENYLIST:-$HOME/.config/headroom-privacy-denylist}"
if [ -f "$PRIVACY_DENYLIST" ]; then
  while IFS= read -r rx; do
    [ -z "$rx" ] && continue; case "$rx" in \#*) continue;; esac
    f=$(git ls-files | grep -v -E '^(LICENSE|package\.json|\.privacy-denylist|scripts/public-audit\.sh)$' | xargs grep -n -E "$rx" 2>/dev/null || true); [ -n "$f" ] && note "denylist hit in files ($rx):"$'\n'"$f"
    h=$(git log -p --all | grep -c -E "$rx" || true); [ "${h:-0}" -gt 0 ] && note "denylist hit in history ($rx): $h lines"
  done < "$PRIVACY_DENYLIST"
fi
[ "$fail" = 0 ] && echo "public-audit: PASS" || { echo "public-audit: FAIL"; exit 1; }
