#!/usr/bin/env bash
set -euo pipefail

swift build -c release --package-path engine
identity="${HEADROOM_CODESIGN_IDENTITY:--}"
codesign --force --sign "$identity" engine/.build/release/headroom-engine
codesign --force --sign "$identity" engine/.build/release/headroom-claude-probe
