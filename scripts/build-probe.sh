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
  # Deliberately not `-p codesigning`: that policy filters to identities
  # macOS's trust evaluation considers valid, and a fresh self-signed
  # certificate is never trusted by default (CSSMERR_TP_NOT_TRUSTED) even
  # though `codesign --sign` itself works fine with it -- codesign only
  # needs a matching private key and certificate, not a trust chain. The
  # bare (no -p) listing still requires a private key, so this can't match
  # a certificate-only entry with no signing key behind it.
  security find-identity login.keychain-db 2>/dev/null | grep -q "\"$local_identity_name\""
}

# Overwrites a file with random bytes before unlinking it, so a plain `rm`
# never leaves key material recoverable from the underlying disk blocks.
# applied to the private key and the PKCS#12 bundle immediately
# after `security import` consumes them -- neither is useful again after
# that, and both are shredded regardless of HEADROOM_BUILD_PROBE_KEEP_WORKDIR.
shred_file() {
  local file="$1" size
  [[ -f "$file" ]] || return 0
  size=$(wc -c < "$file" 2>/dev/null | tr -d ' ')
  if [[ -n "$size" && "$size" -gt 0 ]]; then
    dd if=/dev/urandom of="$file" bs=1 count="$size" conv=notrunc >/dev/null 2>&1 || true
  fi
  rm -f "$file"
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
  # mktemp -d already creates this at mode 0700; chmod explicitly rather
  # than rely on that alone, since the whole point is that no one else can
  # read the private key this directory is about to hold.
  chmod 700 "$workdir"
  if [[ -z "${HEADROOM_BUILD_PROBE_KEEP_WORKDIR:-}" ]]; then
    # shellcheck disable=SC2064
    trap "rm -rf '$workdir'" RETURN
  else
    # Test-only escape hatch (see test/build-probe-script.test.ts): leaves
    # ext.cnf and cert.pem (the openssl config and the public certificate,
    # neither sensitive) in place for a test to inspect. The private key and
    # the PKCS#12 bundle are shredded below regardless of this flag -- it
    # must never be a way to keep key material on disk.
    echo "build-probe.sh: HEADROOM_BUILD_PROBE_KEEP_WORKDIR set; leaving $workdir in place for inspection." >&2
  fi

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

  # a random password generated fresh for this one run, held only
  # in this shell variable -- it is passed to openssl/security via
  # -passout/-P and never written to any file. The export and import below
  # must agree on it (the same random value), unlike the former fixed
  # "headroom" password shared by every build on every machine.
  local p12_password
  p12_password="$(openssl rand -hex 24)"

  # OpenSSL 3's default PKCS#12 encryption (AES-256 keys/certs, SHA-256 MAC)
  # is not something macOS's Security framework can import: `security
  # import` fails with "SecKeychainItemImport: MAC verification failed
  # during PKCS12 import (wrong password?)" even though the passphrase is
  # right, because it never gets far enough to check it. `-legacy` switches
  # back to the RC2/3DES + SHA-1 encryption macOS expects. An OpenSSL build
  # without the legacy provider (older OpenSSL, or a 3.x built without it)
  # doesn't recognize `-legacy` at all; the explicit legacy algorithm names
  # produce the same macOS-readable output there.
  if ! openssl pkcs12 -export -in "$workdir/cert.pem" -inkey "$workdir/key.pem" \
      -out "$workdir/cert.p12" -passout "pass:$p12_password" -name "$local_identity_name" \
      -legacy >/dev/null 2>&1; then
    openssl pkcs12 -export -in "$workdir/cert.pem" -inkey "$workdir/key.pem" \
      -out "$workdir/cert.p12" -passout "pass:$p12_password" -name "$local_identity_name" \
      -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES >/dev/null 2>&1
  fi
  # -T names exactly one application (codesign) allowed to use
  # this key without a prompt; no -A, which would have granted every
  # application silent access to it.
  security import "$workdir/cert.p12" -k login.keychain-db -P "$p12_password" \
    -T /usr/bin/codesign
  # the private key and the PKCS#12 bundle are never needed again
  # after this import -- shred both immediately, whether or not the import
  # above actually succeeded, and regardless of HEADROOM_BUILD_PROBE_KEEP_WORKDIR.
  shred_file "$workdir/key.pem"
  shred_file "$workdir/cert.p12"
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
  # A CI runner has no user whose Keychain grant needs to survive rebuilds,
  # and its keychain search list may not even include the login keychain
  # the identity would be created in. Sign ad-hoc there instead of creating
  # an identity that codesign then cannot find.
  if [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" ]]; then
    printf -- '-'
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
if [[ "$identity" != "-" ]] && ! codesign --force --sign "$identity" "$out_dir/headroom-claude-probe" 2>/dev/null; then
  # The keychain lists the identity but codesign cannot use it (search list,
  # locked keychain, missing partition grant). Ad-hoc keeps the build usable.
  echo "build-probe.sh: codesign could not use '$identity'. Falling back to ad-hoc -- the next Keychain grant will not survive the next rebuild." >&2
  identity="-"
fi
[[ "$identity" == "-" ]] && codesign --force --sign - "$out_dir/headroom-claude-probe"

shasum -a 256 "$out_dir/headroom-claude-probe" | awk '{print $1}' > "$out_dir/SHA256"
printf '%s' "$current_source_hash" > "$out_dir/SOURCE_SHA256"

echo "built $out_dir/headroom-claude-probe (signed: $identity)"
echo "sha256 $(cat "$out_dir/SHA256")"
