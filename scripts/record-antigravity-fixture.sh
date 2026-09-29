#!/usr/bin/env bash
# Record a redacted Antigravity quota fixture from the live local agy, using the
# native engine's normal probe path (`observe --record`). The engine handles
# auth internally; this script never reads or prints tokens, and the recording
# keeps only allowlisted quota fields (identity is written as "redacted").
#
# Usage: scripts/record-antigravity-fixture.sh [--dry-run] <label>
#   <label>     one of: weekly-exhausted, all-fresh, availability-only, loading, other
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
case "$label" in
  weekly-exhausted|all-fresh|availability-only|loading|other) ;;
  *) usage; echo "label must be one of: weekly-exhausted, all-fresh, availability-only, loading, other" >&2; exit 2 ;;
esac

engine="bin/engine/darwin/headroom-engine"
out_dir="test/fixtures/antigravity"
out="$out_dir/$(date -u +%F)-$label.json"

# Same principal the daemon builds (src/registry.ts): name "antigravity",
# location = the Gemini CLI's antigravity-cli directory when present, else "agy".
location="agy"
[[ -d "$HOME/.gemini/antigravity-cli" ]] && location="$HOME/.gemini/antigravity-cli"

json="[{\"id\":\"antigravity\",\"vendor\":\"antigravity\",\"location\":\"$location\"}]"

if (( dry_run == 1 )); then
  echo "would check: $engine exists and is newer than engine sources (never builds)"
  echo "would run: $engine observe --principals /dev/stdin --record $out"
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

# exec: this process becomes the engine (principals JSON on stdin), so there is
# no child, no trap and nothing that can outlive a signal.
exec "$engine" observe --principals /dev/stdin --record "$out" <<<"$json"
