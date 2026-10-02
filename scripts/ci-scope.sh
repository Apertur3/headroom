#!/usr/bin/env bash
# CI scope check: may this run take the docs-only fast path?
#
# Prints exactly one line on stdout, `docs_only=true` or `docs_only=false`,
# for the workflow to append to $GITHUB_OUTPUT. Diagnostics go to stderr.
# Always exits 0. Any doubt, error or unexpected input prints
# docs_only=false, which means the full CI matrix runs.
#
# docs_only=true needs ALL of:
#   - GITHUB_EVENT_NAME is pull_request and GITHUB_REF is refs/pull/<n>/merge
#     (never a push, so never a push to master or a tag)
#   - HEAD is GitHub's synthetic PR merge commit: exactly two parents and the
#     subject "Merge <sha> into <sha>"
#   - the diff from the first parent (the base branch) to HEAD is non-empty,
#     and every path in it, on both sides of a rename (renames are split into
#     delete + add), is a plain file (or deleted) on the allowlist below
#
# Allowlist: README.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md,
# THIRD_PARTY_NOTICES.md, LICENSE, CODE_OF_CONDUCT.md, docs/**,
# .github/ISSUE_TEMPLATE/**, .github/PULL_REQUEST_TEMPLATE*.
# Everything else (src, scripts, tests, workflows, package files, engine,
# fixtures, skills, examples, dotfiles, anything unknown) runs the full CI.
#
# Usage: GITHUB_EVENT_NAME=... GITHUB_REF=... bash scripts/ci-scope.sh
# Runs against the git repository in the current directory.
set -u
set -o pipefail

say() { printf '%s\n' "$1" >&2; }

# Exact top-level files and path prefixes that can never change what the code
# does. Paths are matched as git reports them (repo-relative, `/`-separated),
# after the structural checks below.
allowed_path() {
  local p="$1"
  case "$p" in
    "" | /* | *$'\n'* | *$'\r'* | *\\*) return 1 ;;
  esac
  case "/$p/" in
    */../* | */./* | *//*) return 1 ;;
  esac
  case "$p" in
    README.md | CHANGELOG.md | CONTRIBUTING.md | SECURITY.md | THIRD_PARTY_NOTICES.md | LICENSE | CODE_OF_CONDUCT.md) return 0 ;;
    docs/?* | .github/ISSUE_TEMPLATE/?* | .github/PULL_REQUEST_TEMPLATE*) return 0 ;;
  esac
  return 1
}

# A side of a change is acceptable when it is absent (000000) or a regular
# file. Symlinks (120000) and submodules (160000) are never docs-only.
plain_mode() {
  case "$1" in
    000000 | 100644 | 100755) return 0 ;;
  esac
  return 1
}

decide() {
  if [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]; then
    say "full CI: event is '${GITHUB_EVENT_NAME:-}', not pull_request"
    return 1
  fi
  case "${GITHUB_REF:-}" in
    refs/pull/*/merge) ;;
    *) say "full CI: ref '${GITHUB_REF:-}' is not a pull request merge ref"; return 1 ;;
  esac

  local commit parents subject
  commit="$(git cat-file -p HEAD 2>/dev/null)" || { say "full CI: cannot read HEAD"; return 1; }
  # Only the commit header counts: it ends at the first blank line, so a
  # "parent " line inside a commit message is never counted. awk reads all of
  # its input (no early exit), so no SIGPIPE can turn this into a false error.
  parents="$(printf '%s\n' "$commit" | awk 'h == 0 && /^$/ { h = 1 } h == 0 && /^parent / { n++ } END { print n + 0 }')"
  if [ "$parents" != 2 ]; then
    say "full CI: HEAD has $parents parent(s), not GitHub's two-parent merge commit"
    return 1
  fi
  subject="$(git log -1 --format=%s HEAD 2>/dev/null)" || { say "full CI: cannot read HEAD subject"; return 1; }
  if ! printf '%s\n' "$subject" | grep -qE '^Merge [0-9a-f]{40} into [0-9a-f]{40}$'; then
    say "full CI: HEAD is not GitHub's synthetic PR merge commit"
    return 1
  fi

  # --raw -z: one NUL-terminated ":oldmode newmode oldsha newsha status"
  # record followed by one NUL-terminated path, so spaces, quotes and
  # newlines in names are never split or quoted. --no-renames reports a
  # rename as a delete plus an add, so both paths are checked.
  local raw
  raw="$(mktemp)" || { say "full CI: mktemp failed"; return 1; }
  if ! git -c core.quotePath=false diff --raw -z --no-renames --no-ext-diff --no-textconv \
      --ignore-submodules=none --no-abbrev 'HEAD^1' HEAD > "$raw" 2>/dev/null; then
    rm -f "$raw"
    say "full CI: git diff against the first parent failed"
    return 1
  fi

  local meta path old_mode new_mode status count=0 bad=""
  scope=""
  while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
    count=$((count + 1))
    meta="${meta#:}"
    old_mode="${meta%% *}"
    new_mode="${meta#* }"; new_mode="${new_mode%% *}"
    status="${meta##* }"
    case "$status" in
      A | D | M | T) ;;
      *) bad="$path (status $status)"; break ;;
    esac
    if ! plain_mode "$old_mode" || ! plain_mode "$new_mode"; then
      bad="$path (mode $old_mode -> $new_mode)"; break
    fi
    if ! allowed_path "$path"; then
      bad="$path"; break
    fi
    scope="${scope:+$scope, }$path"
  done < "$raw"
  # Every record is exactly two NUL-terminated fields. Any other NUL count
  # (a truncated or unexpected record the loop above would silently drop)
  # is an error, never a pass.
  local nuls
  nuls="$(tr -cd '\000' < "$raw" | wc -c | tr -d ' ')"
  rm -f "$raw"

  if [ -n "$bad" ]; then
    say "full CI: change outside the docs allowlist: $bad"
    return 1
  fi
  if [ "$count" -eq 0 ]; then
    say "full CI: empty diff against the base branch"
    return 1
  fi
  if [ "$nuls" != "$((count * 2))" ]; then
    say "full CI: unexpected git diff output"
    return 1
  fi
  return 0
}

scope=""
if decide; then
  say "docs-only change: heavy jobs skipped (scope: $scope)"
  printf 'docs_only=true\n'
else
  printf 'docs_only=false\n'
fi
exit 0
