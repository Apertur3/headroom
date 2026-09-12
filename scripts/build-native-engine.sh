#!/usr/bin/env bash
# Build the optional Swift reader as one universal macOS artifact for the npm
# package. This deliberately builds only `headroom-engine`: the Keychain probe
# has its own signing and packaging path in build-probe.sh.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-native-engine.sh: native reader packaging is macOS-only; skipping." >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

usage() {
  echo "usage: scripts/build-native-engine.sh [--force|--refresh-cache]" >&2
}

force_build=0
refresh_cache=0
case "${1:-}" in
  "") ;;
  --force) force_build=1 ;;
  --refresh-cache) refresh_cache=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

out_dir="bin/engine/darwin"
out_binary="$out_dir/headroom-engine"
out_sha="$out_dir/SHA256"
out_source_sha="$out_dir/SOURCE_SHA256"

# The hash proves a staged reader corresponds to this exact pinned package,
# source, build driver, and toolchain. It avoids rebuilding the same verified
# universal artifact during repeated prepack/release checks; --force bypasses
# it for a deliberately fresh build.
toolchain_sha="$(
  {
    swift --version
    xcodebuild -version
  } 2>&1 | shasum -a 256 | awk '{print $1}'
)"

source_sha="$(
  {
    printf '%s\n' '@literal HeadroomEngine native reader source v1'
    # The build driver and compiler version affect the emitted executable too.
    # Include them in the cache key so an Xcode/Swift upgrade rebuilds it.
    printf '%s\n' "@literal toolchain $toolchain_sha"
    printf '%s\n' scripts/build-native-engine.sh engine/Package.swift engine/Package.resolved
    LC_ALL=C find engine/Sources/HeadroomEngine -type f -print | LC_ALL=C sort
  } | while IFS= read -r source_file; do
    if [[ "$source_file" == @literal\ * ]]; then
      printf '%s\n' "$source_file"
    else
      shasum -a 256 "$source_file"
    fi
  done | shasum -a 256 | awk '{print $1}'
)"

is_sha256() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
strict_sha256_file() {
  [[ -f "$1" && "$(wc -c < "$1" | tr -d ' ')" == "65" ]] \
    && LC_ALL=C grep -Eq '^[0-9a-f]{64}$' "$1"
}

verify_universal() {
  local binary="$1" recorded actual architectures
  [[ -f "$binary" && -x "$binary" ]] || return 1
  architectures="$(lipo -archs "$binary")"
  [[ " $architectures " == *" arm64 "* && " $architectures " == *" x86_64 "* ]] || return 1
  [[ "$(wc -w <<<"$architectures" | tr -d ' ')" == "2" ]] || return 1
  strict_sha256_file "$out_sha" || return 1
  recorded="$(<"$out_sha")"
  actual="$(shasum -a 256 "$binary" | awk '{print $1}')"
  is_sha256 "$recorded" && [[ "$recorded" == "$actual" ]]
}

if (( force_build == 0 )) && strict_sha256_file "$out_source_sha" \
  && [[ "$(<"$out_source_sha")" == "$source_sha" ]]; then
  if verify_universal "$out_binary"; then
    echo "native reader: source cache verified"
    exit 0
  fi
fi

# Intended only after a maintainer has verified an already staged artifact and
# changed cache bookkeeping that cannot affect emitted bytes. Normal releases
# use the source match above; --force always rebuilds.
if (( refresh_cache == 1 )); then
  if ! verify_universal "$out_binary"; then
    echo "native reader: cannot refresh an unverified cache" >&2
    exit 1
  fi
  printf '%s\n' "$source_sha" > "$out_source_sha"
  echo "native reader: verified source cache refreshed"
  exit 0
fi

build_root="$(mktemp -d "${TMPDIR:-/tmp}/headroom-native-engine.XXXXXX")"
chmod 700 "$build_root"
trap 'rm -rf "$build_root"' EXIT

build_one() {
  local arch="$1"
  local scratch="$build_root/$arch"
  local log="$build_root/$arch.log"
  mkdir -p "$scratch"
  # Package.swift's macOS 14 platform declaration supplies the deployment
  # target. A separate scratch directory for each slice prevents SwiftPM from
  # ever reusing a host-architecture object as the other architecture. The
  # prefix maps cover both DWARF and runtime #filePath strings in CodexBarCore
  # resources; strip alone cannot remove the latter.
  if ! swift build --package-path engine --scratch-path "$scratch" --configuration release \
      --arch "$arch" --product headroom-engine \
      -Xswiftc -file-prefix-map -Xswiftc "$repo_root=/headroom-source" \
      -Xswiftc -file-prefix-map -Xswiftc "$build_root=/headroom-build" \
      -Xswiftc -debug-prefix-map -Xswiftc "$repo_root=/headroom-source" \
      -Xswiftc -debug-prefix-map -Xswiftc "$build_root=/headroom-build" \
      -Xcc "-fdebug-prefix-map=$repo_root=/headroom-source" \
      -Xcc "-fdebug-prefix-map=$build_root=/headroom-build" \
      -Xcc "-fmacro-prefix-map=$repo_root=/headroom-source" \
      -Xcc "-fmacro-prefix-map=$build_root=/headroom-build" >"$log" 2>&1; then
    echo "native reader: Swift build failed for $arch (details withheld to avoid leaking local paths)" >&2
    return 1
  fi
  local binary="$scratch/$arch-apple-macosx/release/headroom-engine"
  if [[ ! -f "$binary" ]]; then
    # SwiftPM has used both this arch-specific directory and `release` across
    # toolchain versions. It is safe only inside this newly-created scratch.
    binary="$scratch/release/headroom-engine"
  fi
  [[ -f "$binary" ]] || { echo "native reader: Swift did not produce $arch output" >&2; return 1; }
  printf '%s\n' "$binary"
}

arm64_binary="$(build_one arm64)"
x86_64_binary="$(build_one x86_64)"

min_macos_version() {
  otool -l "$1" | awk '
    $1 == "cmd" && ($2 == "LC_BUILD_VERSION" || $2 == "LC_VERSION_MIN_MACOSX") { in_version = 1; next }
    in_version && ($1 == "minos" || $1 == "version") && !seen { print $2; seen = 1 }
  '
}

supports_macos_14() {
  local version="$1"
  awk -v version="$version" 'BEGIN {
    split(version, p, ".")
    major = p[1] + 0; minor = p[2] + 0
    exit !(major < 14 || (major == 14 && minor == 0))
  }'
}

for slice in "$arm64_binary" "$x86_64_binary"; do
  deployment="$(min_macos_version "$slice")"
  if [[ -z "$deployment" ]] || ! supports_macos_14 "$deployment"; then
    echo "native reader: slice does not support macOS 14" >&2
    exit 1
  fi
done

mkdir -p "$out_dir"
candidate="$build_root/headroom-engine"
lipo -create -output "$candidate" "$arm64_binary" "$x86_64_binary"

# `-S` removes DWARF debug sections; `-x` removes local symbols. Both happen
# before the final signature, so the signature covers the stripped bytes.
strip -S -x "$candidate"

# A release binary must not carry a checkout or temporary-build path. Do not
# print matches: this check also runs in CI, whose logs are public.
string_dump="$build_root/strings.txt"
strings -a "$candidate" > "$string_dump"
for private_path in "$repo_root" "$build_root"; do
  if LC_ALL=C grep -Fq "$private_path" "$string_dump"; then
    echo "native reader: refusing artifact with a private source or build path" >&2
    exit 1
  fi
done

candidate_arches="$(lipo -archs "$candidate")"
if [[ " $candidate_arches " != *" arm64 "* || " $candidate_arches " != *" x86_64 "* || \
  "$(wc -w <<<"$candidate_arches" | tr -d ' ')" != "2" ]]; then
  echo "native reader: universal architecture check failed" >&2
  exit 1
fi

# Ad-hoc signing creates no key and never consults a private identity.
codesign --force --sign - --timestamp=none "$candidate"
codesign --verify --strict "$candidate"

candidate_sha="$(shasum -a 256 "$candidate" | awk '{print $1}')"
is_sha256 "$candidate_sha" || { echo "native reader: invalid SHA-256" >&2; exit 1; }

install -m 755 "$candidate" "$out_binary"
printf '%s\n' "$candidate_sha" > "$out_sha"
printf '%s\n' "$source_sha" > "$out_source_sha"

if ! verify_universal "$out_binary"; then
  echo "native reader: staged artifact verification failed" >&2
  exit 1
fi

echo "native reader: built universal arm64+x86_64 macOS 14 artifact"
