#!/usr/bin/env bash
# Restore our compatibility patch before SwiftPM switches pinned revisions.
set -euo pipefail
scratch="${1:-engine/.build}"
if [[ -d "$scratch/checkouts/codexbar" ]]; then
  git -C "$scratch/checkouts/codexbar" reset --hard HEAD
fi
swift package --package-path engine --scratch-path "$scratch" resolve
node scripts/patch-engine-model-catalog.mjs "$scratch/checkouts/codexbar"
