#!/usr/bin/env bash
# Everything a maintainer needs before cutting a release, in one command:
# lint, test, build, a cold-install smoke test, a prod-dependency audit, and a
# canary scan of the actual packed tarball for anything secret-shaped or an
# email address that has no business shipping to npm.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

step() { echo; echo "== $1 =="; }

step "lint"
npm run lint

step "test"
npm test

step "build"
npm run build

step "smoke-cold"
bash scripts/smoke-cold.sh

step "npm audit (production dependencies, high+)"
npm audit --omit=dev --audit-level=high

step "packed tarball canary scan"
root="$(mktemp -d "${TMPDIR:-/tmp}/headroom-release-check.XXXXXX")"
trap 'rm -rf "$root"' EXIT

tarball_dir="$root/tarball"
mkdir -p "$tarball_dir"
tarball_name="$(npm pack --silent --pack-destination "$tarball_dir")"
tarball="$tarball_dir/$tarball_name"

extract_dir="$root/extract"
mkdir -p "$extract_dir"
tar -xzf "$tarball" -C "$extract_dir"
pkg_dir="$extract_dir/package"

# Filenames that should never ship: env files, keys, anything self-described
# as a credential or secret.
suspicious_names="$(find "$pkg_dir" -type f \( \
  -iname '*.env' -o -iname '.env.*' -o -iname '*.pem' -o -iname '*.key' \
  -o -iname '*credential*' -o -iname '*secret*' \
  \) 2>/dev/null || true)"

# Content that looks like a real secret or a real person's email address.
# This is a canary, not a full secret scanner: it exists to catch an
# accidental leak into the shipped package, not to replace the Keychain rule.
secret_pattern='(-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})'
email_pattern='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'

# file:line only -- never the matched line's content, which is the secret
# (or email) itself. This is a CI log; a canary that leaks what it found
# defeats its own purpose.
content_hits="$(grep -rEnI "$secret_pattern|$email_pattern" "$pkg_dir" 2>/dev/null | sed -E 's/^([^:]+:[0-9]+):.*/\1: [REDACTED MATCH]/' || true)"

if [[ -n "$suspicious_names" || -n "$content_hits" ]]; then
  echo "FAIL packed tarball canary scan"
  [[ -n "$suspicious_names" ]] && { echo "suspicious filenames:"; echo "$suspicious_names"; }
  [[ -n "$content_hits" ]] && { echo "suspicious content:"; echo "$content_hits"; }
  exit 1
fi

file_count="$(find "$pkg_dir" -type f | wc -l | tr -d ' ')"
echo "PASS packed tarball canary scan ($tarball_name, $file_count files, none suspicious)"

echo
echo "release:check passed"
