#!/usr/bin/env bash
# An orchestrator's dispatch loop: walk a fallback list of action classes and
# start the job on the first one Headroom says has room. If none does, wait
# instead of starting work that would hit a limit mid-task.
#
# Try it against synthetic data (no logins, nothing real is read):
#   npm run build
#   eval "$(node scripts/demo-home.mjs)"
#   bash examples/orchestrator-loop.sh
#
# These scripts only run against the demo home. To use the same pattern on your
# own accounts, copy the loop into your tooling; action classes come from your
# routing.toml.
set -euo pipefail

# shellcheck source=examples/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OWNER="${OWNER:-orchestrator}"
FALLBACKS=("codex-build" "claude-heavy")   # preferred first

for class in "${FALLBACKS[@]}"; do
  # `can` exits 0 for YES and 2 for NO. A stale or failed reading is a NO
  # (UNKNOWN), never a guess.
  if verdict="$("${headroom_cmd[@]}" can "$class" --owner "$OWNER" 2>/dev/null | head -n 1)"; then
    echo "dispatch on $class: $verdict"
    # Replace this echo with the real job. `headroom run` also reserves the
    # capacity for the duration, so two agents cannot spend the same points:
    #   "${headroom_cmd[@]}" run --meter claude-main:all --need 5h:10 --owner "$OWNER" -- ./job.sh
    exit 0
  fi
  echo "skip $class: $verdict"
done

echo "no class has room; wait for a reset instead of starting work"
echo "  headroom wait --meter <meter> --until-reset --max 6h"
exit 3
