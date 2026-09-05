#!/usr/bin/env bash
# Canary for anything private-life-shaped that has no business in this
# open-source repo or its packed npm tarball: a real email address, a
# private/CGNAT IPv4 address, a real username in a /Users or /home path, or a
# machine/person name listed in .privacy-denylist. A hit here is a bug in a
# fixture or a doc, not a false alarm to silence -- use a documentation-
# reserved placeholder instead (example.com, an RFC 5737 address like
# 192.0.2.x, /Users/test, ...).
#
# Every file in a scan set is grepped in one shared grep process per check
# (not one process per file): kept deliberately batched for speed and to stay
# well clear of any environment's process-spawn ceiling on a repo with a few
# hundred files. Written to run under bash 3.2 (macOS's system default) --
# no associative arrays, no other bash 4+ feature.
#
# Usage:
#   scripts/privacy-sweep.sh [--denylist <path>]        sweep tracked files + the packed tarball
#   scripts/privacy-sweep.sh --check <path> [--denylist <path>]   sweep one file only (for tests)
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Every temp file this script creates is appended here and removed on exit --
# a single trap, since a later `trap ... EXIT` call would silently replace
# (not add to) an earlier one.
cleanup_files=""
trap 'rm -f $cleanup_files' EXIT

# Scan errors are recorded to a real file, not a shell variable: every check
# below runs as the producer side of a `<( )` process substitution or a
# `$( )` command substitution, both of which fork a subshell, so a plain
# `errors=$((errors+1))` inside error_out() would silently vanish once that
# subshell exits. A file survives the fork; its line count, read once at the
# very end, is the real error count.
error_log="$(mktemp)"
cleanup_files="$cleanup_files $error_log"

denylist_file="$repo_root/.privacy-denylist"
check_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) check_path="${2:-}"; shift 2 ;;
    --denylist) denylist_file="${2:-}"; shift 2 ;;
    *) echo "privacy-sweep: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Private names (people, machines, hosts) never live in the tracked denylist.
# They come from an untracked local list, merged in here when present.
local_denylist="${PRIVACY_DENYLIST:-$HOME/.config/headroom-privacy-denylist}"
if [[ -f "$local_denylist" && -f "$denylist_file" ]]; then
  merged_denylist="$(mktemp)"
  cleanup_files="$cleanup_files $merged_denylist"
  cat "$denylist_file" "$local_denylist" > "$merged_denylist"
  denylist_file="$merged_denylist"
fi

EMAIL_PATTERN='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
# RFC 6598 CGNAT is a /10 block: first octet 100, second octet anywhere from
# 64 through 127 -- not just the /16 whose second octet is literally 64. The
# second-octet alternation below spans that full 64-127 range.
IP_PATTERN='(^|[^0-9.])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9.]|$)'
HOME_PATH_PATTERN='(/Users/|/home/)[A-Za-z0-9_.-]+'
ALLOWED_PLACEHOLDER_NAMES='^(you|test|user|example)$'

hits=0

# Prints one finding as "label:line: description" and counts it -- never the
# matched text itself (the finding might BE the secret; the denylist pattern
# name is fine, since the denylist is itself public in the repo).
flag() { echo "$1:$2: $3"; hits=$((hits + 1)); }

# Records a hard scan error (never a "clean pass"). Appends to error_log
# rather than incrementing a variable: every caller of this may be running
# inside a `<( )`/`$( )` subshell (see error_log's own comment above), where
# a variable write would be silently lost.
error_out() { printf 'x' >> "$error_log"; echo "ERROR privacy-sweep: $1" >&2; }

# Runs grep, printing matched lines exactly like a bare `grep` call. Exit
# status 0 (matched) and 1 (no match) both mean grep ran cleanly and produce
# no diagnostic; any other status -- a malformed regex, an unreadable file,
# an argument list the OS refused, ... -- is a hard scan error rather than
# silent "no hits".
run_grep() {
  local outfile errfile status
  outfile="$(mktemp)"; errfile="$(mktemp)"
  grep "$@" >"$outfile" 2>"$errfile"
  status=$?
  if [[ $status -gt 1 ]]; then
    error_out "grep failed (exit $status) for: $*"
    sed 's/^/  /' "$errfile" >&2
  else
    cat "$outfile"
  fi
  rm -f "$outfile" "$errfile"
}

is_license_file() { case "$1" in LICENSE|LICENSE.*|*/LICENSE|*/LICENSE.*) return 0 ;; *) return 1 ;; esac; }
is_package_json() { case "$1" in package.json|*/package.json) return 0 ;; *) return 1 ;; esac; }

# Validates every denylist expression exactly once (a dry match against
# empty input) and returns the path to a filtered copy containing only the
# expressions that compiled cleanly -- so one malformed pattern is reported
# once, not once per file scanned, and never silently treated as "no hits".
# Echoes "" (no filtered file) when there is no denylist to validate.
prepare_denylist() {
  local source="$1"
  [[ -f "$source" && -r "$source" ]] || { printf ''; return 0; }
  local filtered raw test_pattern status
  filtered="$(mktemp)"
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    [[ -z "$raw" || "$raw" == \#* ]] && continue
    test_pattern="$raw"
    [[ "$test_pattern" == '(?i)'* ]] && test_pattern="${test_pattern#'(?i)'}"
    printf '' | grep -qE -- "$test_pattern" 2>/dev/null
    status=$?
    if [[ $status -gt 1 ]]; then
      error_out "invalid denylist expression, skipped: $raw"
      continue
    fi
    echo "$raw" >> "$filtered"
  done < "$source"
  printf '%s' "$filtered"
}

# Runs every check against a single file, reporting hits under $2. Used only
# for package.json's own filtered (author-stripped) temp copy -- one file, so
# a plain per-check grep call is cheap and needs no path relabeling.
scan_one_labeled_file() {
  local path="$1" label="$2" lineno match raw pattern grep_flags
  if [[ ! -f "$path" || ! -r "$path" ]]; then
    error_out "$label is missing or unreadable"
    return 1
  fi

  while IFS=: read -r lineno match; do
    [[ -z "$lineno" ]] && continue
    case "$match" in *@*.example.com|*@example.com) continue ;; esac
    flag "$label" "$lineno" "email address other than example.com"
  done < <(run_grep -noIE "$EMAIL_PATTERN" "$path")

  while IFS=: read -r lineno match; do
    [[ -z "$lineno" ]] && continue
    flag "$label" "$lineno" "private IPv4 address (10.x / 192.168.x / 172.16-31.x / 100.64-127.x CGNAT)"
  done < <(run_grep -noIE "$IP_PATTERN" "$path")

  while IFS=: read -r lineno match; do
    [[ -z "$lineno" ]] && continue
    local name="${match#/Users/}"; name="${name#/home/}"
    if ! printf '%s' "$name" | grep -qiE "$ALLOWED_PLACEHOLDER_NAMES"; then
      flag "$label" "$lineno" "home path with a real username ($name)"
    fi
  done < <(run_grep -noIE "$HOME_PATH_PATTERN" "$path")

  [[ -n "$validated_denylist" && -f "$validated_denylist" ]] || return 0
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    [[ -z "$raw" || "$raw" == \#* ]] && continue
    pattern="$raw"; grep_flags="-nIE"
    if [[ "$pattern" == '(?i)'* ]]; then pattern="${pattern#'(?i)'}"; grep_flags="-ninIE"; fi
    while IFS=: read -r lineno _rest; do
      [[ -z "$lineno" ]] && continue
      flag "$label" "$lineno" "denylist match: $raw"
    done < <(run_grep $grep_flags -- "$pattern" "$path")
  done < "$validated_denylist"
}

# Runs every check across a whole set of files (everything except LICENSE and
# package.json) in one grep invocation per check, prefixing each reported
# path with $1 and stripping $2 (the packed tarball's own extraction root)
# from the front of it first -- empty for the source tree, "packed/" /
# "$pkg_dir/" for the packed tarball. The prefix deliberately has no colon of
# its own: the report line is parsed back apart on ":", and a colon inside
# the path would shift every field after it.
scan_files() {
  local label_prefix="$1" strip_prefix="$2"; shift 2
  local files=("$@")
  [[ "${#files[@]}" -eq 0 ]] && return 0
  local path lineno match raw pattern grep_flags
  local relabel="s#^${strip_prefix}#${label_prefix}#"

  while IFS=: read -r path lineno match; do
    [[ -z "$path" ]] && continue
    case "$match" in *@*.example.com|*@example.com) continue ;; esac
    flag "$path" "$lineno" "email address other than example.com"
  done < <(run_grep -nHoIE "$EMAIL_PATTERN" -- "${files[@]}" | sed -E "$relabel")

  while IFS=: read -r path lineno match; do
    [[ -z "$path" ]] && continue
    flag "$path" "$lineno" "private IPv4 address (10.x / 192.168.x / 172.16-31.x / 100.64-127.x CGNAT)"
  done < <(run_grep -nHoIE "$IP_PATTERN" -- "${files[@]}" | sed -E "$relabel")

  while IFS=: read -r path lineno match; do
    [[ -z "$path" ]] && continue
    local name="${match#/Users/}"; name="${name#/home/}"
    if ! printf '%s' "$name" | grep -qiE "$ALLOWED_PLACEHOLDER_NAMES"; then
      flag "$path" "$lineno" "home path with a real username ($name)"
    fi
  done < <(run_grep -nHoIE "$HOME_PATH_PATTERN" -- "${files[@]}" | sed -E "$relabel")

  [[ -n "$validated_denylist" && -f "$validated_denylist" ]] || return 0
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    [[ -z "$raw" || "$raw" == \#* ]] && continue
    pattern="$raw"; grep_flags="-nHIE"
    if [[ "$pattern" == '(?i)'* ]]; then pattern="${pattern#'(?i)'}"; grep_flags="-nHiIE"; fi
    while IFS=: read -r path lineno _rest; do
      [[ -z "$path" ]] && continue
      flag "$path" "$lineno" "denylist match: $raw"
    done < <(run_grep $grep_flags -- "$pattern" "${files[@]}" | sed -E "$relabel")
  done < "$validated_denylist"
}

scan_source_tree() {
  local rel pkgjson_rel="" files=()
  while IFS= read -r -d '' rel; do
    [[ "$rel" == ".privacy-denylist" ]] && continue
    [[ "$rel" == "scripts/public-audit.sh" ]] && continue  # names the residue words it greps for
    is_license_file "$rel" && continue
    if is_package_json "$rel"; then pkgjson_rel="$rel"; continue; fi
    files=(${files[@]+"${files[@]}"} "$rel")
  done < <(git ls-files -z)
  scan_files "" "" ${files[@]+"${files[@]}"}
  if [[ -n "$pkgjson_rel" ]]; then
    local tmp; tmp="$(mktemp)"
    grep -v '"author"' "$pkgjson_rel" > "$tmp" 2>/dev/null
    scan_one_labeled_file "$tmp" "$pkgjson_rel"
    rm -f "$tmp"
  fi
}

scan_packed_tarball() {
  local root tarball_dir tarball_name tarball extract_dir pkg_dir file
  local pkgjson_file="" files=()
  root="$(mktemp -d "${TMPDIR:-/tmp}/headroom-privacy-sweep.XXXXXX")"
  tarball_dir="$root/tarball"
  mkdir -p "$tarball_dir"
  tarball_name="$(npm pack --silent --pack-destination "$tarball_dir")" || { echo "privacy-sweep: npm pack failed"; rm -rf "$root"; exit 1; }
  tarball="$tarball_dir/$tarball_name"
  extract_dir="$root/extract"
  mkdir -p "$extract_dir"
  tar -xzf "$tarball" -C "$extract_dir" || { echo "privacy-sweep: failed to extract packed tarball"; rm -rf "$root"; exit 1; }
  pkg_dir="$extract_dir/package"
  while IFS= read -r -d '' file; do
    is_license_file "$file" && continue
    if is_package_json "$file"; then pkgjson_file="$file"; continue; fi
    files=(${files[@]+"${files[@]}"} "$file")
  done < <(find "$pkg_dir" -type f -print0)
  scan_files "packed/" "$pkg_dir/" ${files[@]+"${files[@]}"}
  if [[ -n "$pkgjson_file" ]]; then
    local tmp; tmp="$(mktemp)"
    grep -v '"author"' "$pkgjson_file" > "$tmp" 2>/dev/null
    scan_one_labeled_file "$tmp" "packed/package.json"
    rm -f "$tmp"
  fi
  rm -rf "$root"
}

validated_denylist="$(prepare_denylist "$denylist_file")"
[[ -n "$validated_denylist" ]] && cleanup_files="$cleanup_files $validated_denylist"

if [[ -n "$check_path" ]]; then
  scan_one_labeled_file "$check_path" "$check_path"
else
  scan_source_tree
  scan_packed_tarball
fi

errors=$(wc -c < "$error_log" | tr -d ' ')
if [[ "$hits" -gt 0 || "$errors" -gt 0 ]]; then
  echo
  [[ "$hits" -gt 0 ]] && echo "FAIL privacy sweep: $hits finding(s) above"
  [[ "$errors" -gt 0 ]] && echo "FAIL privacy sweep: $errors scan error(s) above (never treated as a clean pass)"
  exit 1
fi
if [[ -n "$check_path" ]]; then echo "PASS privacy sweep ($check_path clean)"
else echo "PASS privacy sweep (tracked files + packed tarball clean)"
fi
