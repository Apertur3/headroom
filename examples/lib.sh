# Shared guard for the examples/ scripts (sourced, not run). It refuses to
# continue unless HEADROOM_HOME points at a synthetic demo home, so none of the
# scripts can run against a real ~/.headroom, and it picks the repo build over
# any global `headroom` that may be a different version.
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "${HEADROOM_HOME:-}" ]; then
  echo "HEADROOM_HOME is not set. These examples only run against a synthetic demo home:" >&2
  echo "  npm run build && eval \"\$(node scripts/demo-home.mjs)\"" >&2
  exit 64
fi
if [ ! -f "$HEADROOM_HOME/.headroom-demo-home" ]; then
  echo "HEADROOM_HOME=$HEADROOM_HOME is not a demo home (no .headroom-demo-home marker); refusing to run." >&2
  echo "Build one with: npm run build && eval \"\$(node scripts/demo-home.mjs)\"" >&2
  exit 64
fi

if [ -n "${HEADROOM:-}" ]; then
  headroom_cmd=("$HEADROOM")
elif [ -f "$repo/dist/cli.js" ]; then
  headroom_cmd=(node "$repo/dist/cli.js")
else
  echo "dist/cli.js not found; run: npm run build" >&2
  exit 64
fi
echo "using: ${headroom_cmd[*]} (HEADROOM_HOME=$HEADROOM_HOME)" >&2
