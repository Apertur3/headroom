#!/usr/bin/env bash
# Resolve the pinned package, then preserve the models in its existing status read.
set -euo pipefail
scratch="${1:-engine/.build}"
swift package --package-path engine --scratch-path "$scratch" resolve
node scripts/patch-engine-model-catalog.mjs "$scratch/checkouts/codexbar"
