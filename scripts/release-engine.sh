#!/usr/bin/env bash
set -euo pipefail

# Run this on each macOS release builder. Linux archives are built by the
# corresponding Linux CI runners with the same archive layout.
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "release-engine.sh builds macOS binaries; run on macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) target="macos-arm64" ;;
  x86_64) target="macos-x86_64" ;;
  *) echo "unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

version="$(node -p 'require("./package.json").version')"
asset="tally-engine-${version}-${target}.tar.gz"
out="dist/release-engine"
binary="engine/.build/release/tally-engine"

npm run engine:build

# Release hook: a CI secret may set TALLY_CODESIGN_IDENTITY to an approved
# identity. Local builds use ad-hoc signing only; this script never chooses a
# real identity itself.
codesign --force --sign "${TALLY_CODESIGN_IDENTITY:--}" "$binary"

mkdir -p "$out"
tar -C "$(dirname "$binary")" -czf "$out/$asset" "$(basename "$binary")"
shasum -a 256 "$out/$asset"
echo "created $out/$asset"
