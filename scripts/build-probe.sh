#!/usr/bin/env bash
# Builds the Claude Keychain probe as a universal (arm64 + x86_64) macOS
# binary and stages it where src/adapters/claude.ts's keychainHelper()
# resolves it for a packaged install: bin/probe/darwin/headroom-claude-probe,
# with its SHA-256 recorded alongside it in bin/probe/darwin/SHA256.
#
# Runs automatically before `npm pack`/`npm publish` (package.json's
# `prepack`), so a macOS user installing from npm gets a working probe
# without a local Swift toolchain. The binary is ad-hoc signed by this
# script, not by a Developer ID identity, so macOS Gatekeeper still pops one
# Keychain access dialog per package update -- fine for a beta; see
# docs/quickstart.md.
#
# Never committed to git: see .gitignore's `bin/probe/`. On any non-macOS
# platform this is a no-op, so the same `prepack` step is safe everywhere.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-probe.sh: not macOS, skipping (the packaged Claude probe is macOS-only)." >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! command -v swift >/dev/null 2>&1; then
  echo "build-probe.sh: no Swift toolchain found; skipping. Install Xcode command line tools to build the probe." >&2
  exit 0
fi

swift build -c release --package-path engine --product headroom-claude-probe --arch arm64 --arch x86_64

built="engine/.build/apple/Products/Release/headroom-claude-probe"
if [[ ! -f "$built" ]]; then
  # A toolchain without the merged multi-arch "apple" plan directory places
  # the (possibly single-arch) binary at the top of .build instead.
  built="engine/.build/release/headroom-claude-probe"
fi
if [[ ! -f "$built" ]]; then
  echo "build-probe.sh: expected binary not found after swift build (checked engine/.build/apple/Products/Release and engine/.build/release)" >&2
  exit 1
fi

out_dir="bin/probe/darwin"
mkdir -p "$out_dir"
cp "$built" "$out_dir/headroom-claude-probe"
chmod 0755 "$out_dir/headroom-claude-probe"

identity="${HEADROOM_CODESIGN_IDENTITY:--}"
codesign --force --sign "$identity" "$out_dir/headroom-claude-probe"

shasum -a 256 "$out_dir/headroom-claude-probe" | awk '{print $1}' > "$out_dir/SHA256"

echo "built $out_dir/headroom-claude-probe"
echo "sha256 $(cat "$out_dir/SHA256")"
