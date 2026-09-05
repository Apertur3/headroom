#!/usr/bin/env bash
# Builds the Claude Keychain probe as a universal (arm64 + x86_64) macOS
# binary and stages it where src/adapters/claude.ts's keychainHelper()
# resolves it for a packaged install: bin/probe/darwin/headroom-claude-probe,
# with its SHA-256 recorded alongside it in bin/probe/darwin/SHA256.
#
# Runs automatically before `npm pack`/`npm publish` (package.json's
# `prepack`) and from `release:check`, so a macOS user installing from npm
# gets a working probe without a local Swift toolchain.
#
# Signing identity: by default this signs with a stable, self-signed local
# identity ("Headroom Local", created once in the login keychain) rather
# than ad-hoc. Ad-hoc signing makes every single build a brand-new,
# unrecognized signing identity to Keychain -- every `npm pack`, every
# `release:check`, every global reinstall invalidated the operator's prior
# `headroom keychain grant`, so the Keychain access dialog kept coming back
# on a machine that had already granted it. Signing every build under the
# same identity means one grant survives rebuilds. Set
# HEADROOM_CODESIGN_IDENTITY to use a different identity (e.g. a real
# Developer ID once this ships past beta); if identity creation fails for
# any reason, this falls back to ad-hoc with a printed warning rather than
# failing the build. See docs/quickstart.md.
#
# Rebuild skip: the probe is only actually rebuilt when its source (this
# directory's Swift sources plus Package.swift) has changed since the last
# build, recorded as a hash next to the binary (bin/probe/darwin/SOURCE_SHA256).
# `release:check` and `prepack` both end up calling this script on every
# release, and a `swift build` (plus, previously, a full re-sign under a
# fresh ad-hoc identity) on every one of those was itself part of what kept
# invalidating grants for no source change at all.
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

out_dir="bin/probe/darwin"
mkdir -p "$out_dir"

# Deterministic regardless of filesystem enumeration order: hash every
# source file's own digest, sorted, then hash that list. Package.swift is a
# single file, not a directory; `find` accepts both in one invocation.
source_hash() {
  find engine/Sources/HeadroomClaudeProbe engine/Package.swift -type f -print0 2>/dev/null \
    | sort -z \
    | xargs -0 shasum -a 256 \
    | shasum -a 256 \
    | awk '{print $1}'
}

current_source_hash="$(source_hash)"
if [[ -f "$out_dir/headroom-claude-probe" && -f "$out_dir/SOURCE_SHA256" \
      && "$(cat "$out_dir/SOURCE_SHA256")" == "$current_source_hash" ]]; then
  echo "build-probe.sh: source unchanged (sha256 $current_source_hash); reusing $out_dir/headroom-claude-probe"
  echo "sha256 $(cat "$out_dir/SHA256")"
  exit 0
fi

local_identity_name="Headroom Local"

identity_exists() {
  security find-identity -v -p codesigning login.keychain-db 2>/dev/null | grep -q "\"$local_identity_name\""
}

# Creates a self-signed, codeSigning-EKU certificate named "Headroom Local"
# in the login keychain. Called at most once ever on a given machine:
# subsequent runs find the existing identity via identity_exists() above.
# This itself touches the login keychain and may prompt once for keychain
# access -- a one-time cost in exchange for never prompting again on every
# rebuild after.
create_local_identity() {
  local workdir
  workdir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$workdir'" RETURN

  cat > "$workdir/ext.cnf" <<CONF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = $local_identity_name
[v3_req]
extendedKeyUsage = codeSigning
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
CONF

  openssl req -x509 -newkey rsa:2048 -keyout "$workdir/key.pem" -out "$workdir/cert.pem" \
    -days 36500 -nodes -config "$workdir/ext.cnf" -extensions v3_req >/dev/null 2>&1
  openssl pkcs12 -export -in "$workdir/cert.pem" -inkey "$workdir/key.pem" \
    -out "$workdir/cert.p12" -passout pass:headroom -name "$local_identity_name" >/dev/null 2>&1
  security import "$workdir/cert.p12" -k login.keychain-db -P headroom \
    -T /usr/bin/codesign -T /usr/bin/security
  # Grants codesign non-interactive use of the new key's partition; a known
  # macOS ACL quirk (since Sierra) that otherwise pops "codesign wants to use
  # your key... Always Allow" on every single sign. Best effort: absent on
  # older macOS, harmless either way.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" login.keychain-db >/dev/null 2>&1 || true
}

resolve_identity() {
  if [[ -n "${HEADROOM_CODESIGN_IDENTITY:-}" ]]; then
    printf '%s' "$HEADROOM_CODESIGN_IDENTITY"
    return
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "build-probe.sh: no openssl found; cannot create a stable local signing identity. Falling back to ad-hoc -- the next Keychain grant will not survive the next rebuild." >&2
    printf -- '-'
    return
  fi
  if ! identity_exists && ! create_local_identity; then
    echo "build-probe.sh: could not create the '$local_identity_name' signing identity. Falling back to ad-hoc -- the next Keychain grant will not survive the next rebuild." >&2
    printf -- '-'
    return
  fi
  if identity_exists; then
    printf '%s' "$local_identity_name"
  else
    echo "build-probe.sh: '$local_identity_name' still not found after attempting to create it. Falling back to ad-hoc -- the next Keychain grant will not survive the next rebuild." >&2
    printf -- '-'
  fi
}

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

cp "$built" "$out_dir/headroom-claude-probe"
chmod 0755 "$out_dir/headroom-claude-probe"

identity="$(resolve_identity)"
codesign --force --sign "$identity" "$out_dir/headroom-claude-probe"

shasum -a 256 "$out_dir/headroom-claude-probe" | awk '{print $1}' > "$out_dir/SHA256"
printf '%s' "$current_source_hash" > "$out_dir/SOURCE_SHA256"

echo "built $out_dir/headroom-claude-probe (signed: $identity)"
echo "sha256 $(cat "$out_dir/SHA256")"
