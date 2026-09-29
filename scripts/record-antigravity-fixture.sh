#!/usr/bin/env bash
# Record a redacted Antigravity quota fixture from the live local agy, using the
# native engine's normal probe path (`observe --record`). The engine handles
# auth internally; this script never reads or prints tokens, and the recording
# keeps only allowlisted quota fields (identity is written as "redacted").
#
# Usage: scripts/record-antigravity-fixture.sh [--dry-run] <label>
#   <label>     short kebab-case name, e.g. gemini-weekly-exhausted
#   --dry-run   print the exact engine command and stop before invoking it
#
# Output: test/fixtures/antigravity/<YYYY-MM-DD>-<label>.json (mode 0600).
# Run this only while agy is up (the engine does not start a competing agy).
# The engine binary must already be built (bash scripts/build-native-engine.sh).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

usage() { echo "usage: scripts/record-antigravity-fixture.sh [--dry-run] <label>" >&2; }

dry_run=0
label=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) usage; exit 2 ;;
    *) [[ -z "$label" ]] || { usage; exit 2; }; label="$arg" ;;
  esac
done
[[ "$label" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || { usage; echo "label must be kebab-case (a-z, 0-9, -)" >&2; exit 2; }

engine="bin/engine/darwin/headroom-engine"
out_dir="test/fixtures/antigravity"
out="$out_dir/$(date -u +%F)-$label.json"

# Same principal the daemon builds (src/registry.ts): name "antigravity",
# location = the Gemini CLI's antigravity-cli directory when present, else "agy".
location="agy"
[[ -d "$HOME/.gemini/antigravity-cli" ]] && location="$HOME/.gemini/antigravity-cli"

principals="$(mktemp "${TMPDIR:-/tmp}/headroom-record-principals.XXXXXX")"
chmod 600 "$principals"
trap 'rm -f "$principals"' EXIT
printf '[{"id":"antigravity","vendor":"antigravity","location":"%s"}]\n' "$location" > "$principals"

if (( dry_run == 1 )); then
  echo "would check: $engine exists and is newer than engine sources (never builds)"
  echo "would run: $engine observe --principals <temp principals json> --record $out"
  exit 0
fi

[[ ! -e "$out" ]] || { echo "refusing to overwrite $out" >&2; exit 1; }

# This script never builds: a build writes trees, logs and digests well beyond
# the fixture. Stop and print the command instead.
stale=""
if [[ ! -x "$engine" ]]; then
  stale="missing"
elif [[ -n "$(find engine/Sources/HeadroomEngine engine/Package.swift engine/Package.resolved scripts/build-native-engine.sh -type f -newer "$engine" -print -quit 2>/dev/null)" ]]; then
  stale="older than the engine sources"
fi
if [[ -n "$stale" ]]; then
  echo "$engine is $stale. Build it first, then re-run:" >&2
  echo "  bash scripts/build-native-engine.sh" >&2
  exit 1
fi

mkdir -p "$out_dir"
umask 077

# Run the engine in its own process group (set -m) and forward INT/TERM/HUP to
# that group, then wait for it, so nothing from this run outlives the wrapper.
# The traps are installed BEFORE the child starts: a signal in between would
# otherwise kill the wrapper and orphan the engine.
engine_pid=""
got_signal=0
forward() {
  got_signal=1
  if [[ -n "$engine_pid" ]]; then kill -TERM -- "-$engine_pid" 2>/dev/null || true; fi
}
trap forward INT TERM HUP
set -m
"$engine" observe --principals "$principals" --record "$out" &
engine_pid=$!
# A signal that landed before the pid was known is honoured now.
if (( got_signal == 1 )); then kill -TERM -- "-$engine_pid" 2>/dev/null || true; fi
status=0
wait "$engine_pid" || status=$?
if (( got_signal == 1 )); then
  # `wait` returned because of the signal. Give the group 5 s (50 x 0.1 s) to
  # exit on TERM, poll without blocking, then SIGKILL whatever is left.
  tries=0
  while kill -0 -- "-$engine_pid" 2>/dev/null && (( tries < 50 )); do
    sleep 0.1
    tries=$((tries + 1))
  done
  if kill -0 -- "-$engine_pid" 2>/dev/null; then kill -KILL -- "-$engine_pid" 2>/dev/null || true; fi
  wait "$engine_pid" 2>/dev/null || true
fi
trap - INT TERM HUP
set +m
if (( got_signal == 1 )); then
  echo "interrupted; engine stopped" >&2
  exit 130
fi
(( status == 0 )) || { echo "engine exited with status $status" >&2; exit "$status"; }
echo "wrote $out (mode $(stat -f %Lp "$out" 2>/dev/null || stat -c %a "$out"))"
echo "review it, then run scripts/privacy-sweep.sh before committing"
