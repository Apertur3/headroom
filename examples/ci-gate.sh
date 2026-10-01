#!/usr/bin/env bash
# A CI or pre-commit gate: refuse to start an expensive agent job when the
# budget cannot cover it. `gate` exits 0 when the job fits and 2 when it does
# not; a stale or failed reading counts as "does not fit".
#
# Try it against synthetic data:
#   npm run build
#   eval "$(node scripts/demo-home.mjs)"
#   bash examples/ci-gate.sh                 # a small job fits on claude-main
#   NEED_WK=60 METER=codex-main:main bash examples/ci-gate.sh   # refused
set -euo pipefail

HEADROOM="${HEADROOM:-headroom}"
METER="${METER:-claude-main:all}"
NEED_WK="${NEED_WK:-5}"

if "$HEADROOM" gate --need "wk:${NEED_WK}" --meter "$METER" --owner ci 2>/dev/null; then
  echo "budget ok, starting the agent job"
else
  echo "budget check failed for ${METER} (needs ${NEED_WK} weekly points); not starting the job" >&2
  exit 1
fi
