#!/usr/bin/env bash
# Wait for npm's registry to serve the verified GitHub release bytes.
set -euo pipefail
version="${1:-}"
expected="${2:-}"
delay="${HEADROOM_REGISTRY_RETRY_SECONDS:-10}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]] || { echo "Invalid release version" >&2; exit 1; }
[[ "$expected" =~ ^sha512-[A-Za-z0-9+/]+=*$ ]] || { echo "Invalid release integrity" >&2; exit 1; }
[[ "$delay" =~ ^[0-9]+$ ]] || { echo "Invalid registry retry delay" >&2; exit 1; }
for attempt in {1..12}; do
  actual="$(npm view "headroomd@$version" dist.integrity --prefer-online --fetch-retries=0 --fetch-timeout=10000 2>/dev/null || true)"
  if [[ "$actual" == "$expected" ]]; then
    echo "npm headroomd@$version matches the release asset"
    exit 0
  fi
  if [[ -n "$actual" ]]; then
    echo "::error::npm headroomd@$version does not match the GitHub release asset; refusing to update Homebrew" >&2
    exit 1
  fi
  if [[ "$attempt" -lt 12 ]]; then
    echo "npm headroomd@$version is not visible yet (attempt $attempt/12); retrying"
    sleep "$delay"
  fi
done
echo "::error::npm headroomd@$version is still unavailable after 12 attempts; rerun the Homebrew job after publication succeeds" >&2
exit 1
