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
# identity ("Headroom Local", created once) rather than ad-hoc. Ad-hoc
# signing makes every single build a brand-new, unrecognized signing
# identity to Keychain -- every `npm pack`, every `release:check`, every
# global reinstall invalidated the operator's prior `headroom keychain
# grant`, so the Keychain access dialog kept coming back on a machine that
# had already granted it. macOS keys a Keychain item's ACL on the trusted
# application's designated requirement, which for this identity is
# `identifier "headroom-claude-probe" and certificate leaf = H"<cert>"` --
# the certificate, not the binary's contents. Signing every build under the
# same identity therefore means one grant survives every rebuild.
#
# Where the identity lives: a dedicated keychain,
# ~/Library/Keychains/headroom-local-signing.keychain-db, appended to the
# user's keychain search list so codesign can find it. It is deliberately
# NOT the login keychain: a private key imported into the login keychain
# cannot be given a partition list without the login password, so codesign
# stops on a "wants to use your confidential information" dialog on every
# single sign -- which is exactly the hang an unattended `npm pack` must
# never take. See SECURITY.md for what that key can and cannot do.
#
# Overriding it: set HEADROOM_CODESIGN_IDENTITY, or run
# `git config headroom.codesign-identity "Developer ID Application: ..."`
# (untracked, per clone), to sign with a real identity instead. Whichever
# is configured, a sign that has not finished within
# HEADROOM_CODESIGN_TIMEOUT_SECONDS (default 30) is abandoned and the build
# falls back to ad-hoc with a printed warning rather than sitting on a
# Keychain dialog nobody is there to click. See docs/quickstart.md.
#
# Starting over: `bash scripts/build-probe.sh --reset-identity` deletes the
# local identity, its certificate and its keychain (plus any "Headroom
# Local" leftovers in the login keychain from before this script used a
# dedicated one), then exits. The next build creates one fresh identity.
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

out_dir="bin/probe/darwin"
local_identity_name="Headroom Local"
signing_keychain_name="headroom-local-signing.keychain-db"
signing_keychain="$HOME/Library/Keychains/$signing_keychain_name"
# The empty passphrase below is on this keychain and nothing else. It is
# what makes `security set-key-partition-list` work without a human, which
# is what makes an unattended `codesign` not stop on a dialog. The file
# itself is chmod 0600, and the key inside it signs nothing but this
# machine's own probe builds.
signing_keychain_password=""
codesign_timeout_seconds="${HEADROOM_CODESIGN_TIMEOUT_SECONDS:-30}"

# The SHA-1 hashes of every identity named "$local_identity_name" in the
# signing keychain, one per line. Deliberately not `-v -p codesigning`:
# those filter to identities macOS's trust evaluation considers valid, and
# a fresh self-signed certificate is never trusted by default
# (CSSMERR_TP_NOT_TRUSTED) even though `codesign --sign` works fine with it
# -- codesign needs a matching private key and certificate, not a trust
# chain. Filtering on `-v` was the original defect: identity_exists() never
# matched the identity it had just created, so every build created another
# one, and once more than one existed `codesign --sign "Headroom Local"`
# failed with "ambiguous (matches ... and ...)" and fell back to ad-hoc.
# Signing by hash instead of by name means duplicates can never be
# ambiguous again. The bare listing still requires a private key, so this
# cannot match a certificate with no signing key behind it.
identity_hashes() {
  security find-identity "$signing_keychain" 2>/dev/null \
    | awk -v name="\"$local_identity_name\"" '$0 ~ name {print $2}' \
    | grep -E '^[0-9A-Fa-f]{40}$' || true
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

# Appends the signing keychain to the user's keychain search list, which is
# what lets `codesign --sign` find an identity that is not in the login
# keychain (codesign's own --keychain flag narrows the search list, it does
# not add to it). Reads the current list first and re-sets it verbatim plus
# the one new entry: `security list-keychains -s` REPLACES the list, so a
# careless call here would silently drop the login keychain. A read that
# comes back empty is treated as "cannot tell" and left alone.
add_to_search_list() {
  local -a current=()
  local line
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%\"}"
    line="${line#\"}"
    [[ -n "$line" ]] && current+=("$line")
  done < <(security list-keychains -d user 2>/dev/null)
  (( ${#current[@]} )) || return 0
  for line in "${current[@]}"; do
    [[ "$line" == "$signing_keychain" ]] && return 0
  done
  security list-keychains -d user -s "${current[@]}" "$signing_keychain" >/dev/null 2>&1 || return 1
}

remove_from_search_list() {
  local -a current=() kept=()
  local line
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%\"}"
    line="${line#\"}"
    [[ -n "$line" ]] && current+=("$line")
  done < <(security list-keychains -d user 2>/dev/null)
  (( ${#current[@]} )) || return 0
  for line in "${current[@]}"; do
    [[ "$line" == "$signing_keychain" ]] || kept+=("$line")
  done
  (( ${#kept[@]} )) || return 0
  (( ${#kept[@]} == ${#current[@]} )) && return 0
  security list-keychains -d user -s "${kept[@]}" >/dev/null 2>&1 || return 1
}

# Creates the dedicated keychain if it is not already there, unlocked and
# with no auto-lock, so a later build never fails on a locked keychain.
ensure_signing_keychain() {
  if [[ ! -f "$signing_keychain" ]]; then
    security create-keychain -p "$signing_keychain_password" "$signing_keychain" >/dev/null 2>&1 || return 1
    chmod 0600 "$signing_keychain" 2>/dev/null || true
  fi
  # No -l/-t: never auto-lock on sleep or on a timeout, or an unattended
  # build hours later would be back to a dialog.
  security set-keychain-settings "$signing_keychain" >/dev/null 2>&1 || true
  security unlock-keychain -p "$signing_keychain_password" "$signing_keychain" >/dev/null 2>&1 || true
  add_to_search_list || true
}

# Creates a self-signed, codeSigning-EKU certificate named "Headroom Local"
# in the signing keychain. Called at most once ever on a given machine:
# subsequent runs find the existing identity via identity_hashes() above.
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

  ensure_signing_keychain || {
    echo "build-probe.sh: could not create or unlock $signing_keychain." >&2
    return 1
  }

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
    -days 36500 -nodes -config "$workdir/ext.cnf" -extensions v3_req >/dev/null 2>&1 || {
    echo "build-probe.sh: openssl could not generate the '$local_identity_name' key pair." >&2
    return 1
  }

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
      -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES >/dev/null 2>&1 || {
      shred_file "$workdir/key.pem"
      echo "build-probe.sh: openssl could not export the '$local_identity_name' PKCS#12 bundle." >&2
      return 1
    }
  fi

  # -T names exactly one application (codesign) allowed to use
  # this key without a prompt; no -A, which would have granted every
  # application silent access to it.
  local import_status=0
  security import "$workdir/cert.p12" -k "$signing_keychain" -P "$p12_password" \
    -T /usr/bin/codesign || import_status=$?
  # the private key and the PKCS#12 bundle are never needed again
  # after this import -- shred both immediately, whether or not the import
  # above actually succeeded, and regardless of HEADROOM_BUILD_PROBE_KEEP_WORKDIR.
  shred_file "$workdir/key.pem"
  shred_file "$workdir/cert.p12"
  (( import_status == 0 )) || {
    echo "build-probe.sh: 'security import' rejected the '$local_identity_name' identity." >&2
    return 1
  }

  # Grants codesign non-interactive use of the new key's partition. Without
  # it macOS pops "codesign wants to use your confidential information
  # stored in Headroom Local" on every single sign (a known quirk since
  # Sierra) and an unattended build sits there until it is killed. This is
  # the whole reason the identity lives in a keychain whose passphrase this
  # script knows: on the login keychain the same call needs the login
  # password and cannot be made.
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "$signing_keychain_password" "$signing_keychain" >/dev/null 2>&1 \
    || echo "build-probe.sh: could not set the key partition list; codesign may prompt once." >&2
}

# Deletes every "Headroom Local" identity and certificate this script has
# ever created, in the dedicated keychain and (for machines built before
# the dedicated keychain existed) in the login keychain too, then drops the
# keychain and the search-list entry. `security delete-identity` asks for
# confirmation on stdin, hence the piped "y".
reset_identity() {
  local removed=0 keychain hash attempt
  for keychain in "$signing_keychain" "$HOME/Library/Keychains/login.keychain-db"; do
    [[ -f "$keychain" ]] || continue
    # Bounded rather than `while :`: a `security` that keeps reporting the
    # item and keeps reporting a successful delete must not spin forever.
    attempt=0
    while (( attempt++ < 100 )); do
      hash="$(security find-identity "$keychain" 2>/dev/null \
        | awk -v name="\"$local_identity_name\"" '$0 ~ name {print $2}' \
        | grep -E '^[0-9A-Fa-f]{40}$' | head -1 || true)"
      [[ -n "$hash" ]] || break
      # A here-string, not `yes |`: delete-identity asks for confirmation on
      # stdin, and a pipe whose writer takes SIGPIPE would fail the whole
      # pipeline under `set -o pipefail` even when the delete succeeded.
      security delete-identity -Z "$hash" "$keychain" >/dev/null 2>&1 <<< "y" || break
      removed=$((removed + 1))
    done
    # A certificate whose private key was already gone is not an identity
    # and never shows up above, so sweep those by name as well.
    attempt=0
    while (( attempt++ < 100 )); do
      security find-certificate -c "$local_identity_name" "$keychain" >/dev/null 2>&1 || break
      security delete-certificate -c "$local_identity_name" "$keychain" >/dev/null 2>&1 || break
      removed=$((removed + 1))
    done
  done
  if [[ -f "$signing_keychain" ]]; then
    remove_from_search_list || true
    security delete-keychain "$signing_keychain" >/dev/null 2>&1 || true
  fi
  # Force the next build to actually rebuild and re-sign rather than reuse
  # the binary that was signed by the identity just deleted.
  rm -f "$out_dir/SOURCE_SHA256"
  echo "build-probe.sh: removed $removed '$local_identity_name' keychain item(s); the next build creates one fresh identity."
}

if [[ "${1:-}" == "--reset-identity" ]]; then
  reset_identity
  exit 0
fi
if [[ -n "${1:-}" ]]; then
  echo "build-probe.sh: unknown argument '$1' (only --reset-identity is accepted)." >&2
  exit 2
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "build-probe.sh: no Swift toolchain found; skipping. Install Xcode command line tools to build the probe." >&2
  exit 0
fi

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

# An identity the maintainer configured explicitly, from the environment or
# from this clone's own git config. `git config` is read per repo and is
# never committed, so a maintainer with a Developer ID can set it once
# without it leaking into anyone else's checkout.
configured_identity() {
  if [[ -n "${HEADROOM_CODESIGN_IDENTITY:-}" ]]; then
    printf '%s' "$HEADROOM_CODESIGN_IDENTITY"
    return
  fi
  command -v git >/dev/null 2>&1 || return 0
  git -C "$repo_root" config --get headroom.codesign-identity 2>/dev/null || true
}

# Sets `identity` (what codesign is asked to sign with: "-" for ad-hoc, a
# SHA-1 hash for the local identity, whatever the maintainer configured
# otherwise) and `identity_label` (what the build prints).
identity="-"
identity_label="-"
resolve_identity() {
  local configured hashes count
  configured="$(configured_identity)"
  if [[ -n "$configured" ]]; then
    identity="$configured"
    identity_label="$configured"
    return
  fi
  # A CI runner has no user whose Keychain grant needs to survive rebuilds,
  # and its keychain search list may not even include the keychain the
  # identity would be created in. Sign ad-hoc there instead of creating an
  # identity that codesign then cannot find.
  if [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" ]]; then
    return
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "build-probe.sh: no openssl found; cannot create a stable local signing identity. Falling back to ad-hoc -- the next Keychain grant will not survive the next rebuild." >&2
    return
  fi
  hashes="$(identity_hashes)"
  if [[ -z "$hashes" ]]; then
    create_local_identity || true
    hashes="$(identity_hashes)"
  fi
  if [[ -z "$hashes" ]]; then
    echo "build-probe.sh: could not create the '$local_identity_name' signing identity. Falling back to ad-hoc -- the next Keychain grant will not survive the next rebuild." >&2
    return
  fi
  count="$(printf '%s\n' "$hashes" | awk 'NF {n++} END {print n + 0}')"
  if (( count > 1 )); then
    # Only reachable on a machine that ran the version of this script whose
    # existence check could not see its own identity. Signing by the first
    # hash is still stable across rebuilds, but the duplicates are junk.
    echo "build-probe.sh: $count '$local_identity_name' identities found; using the first. Run 'bash scripts/build-probe.sh --reset-identity' to clear them." >&2
  fi
  identity="$(printf '%s\n' "$hashes" | head -1)"
  identity_label="$local_identity_name ($identity)"
}

# codesign stops on a Keychain dialog when it cannot use a key
# non-interactively, and an unattended `npm pack` would then hang forever.
# Run it in the background and give up after codesign_timeout_seconds.
sign_with_timeout() {
  local target="$1" pid waited=0 status=0
  codesign --force --sign "$identity" "$target" 2>/dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= codesign_timeout_seconds )); then
      kill -9 "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
      echo "build-probe.sh: codesign did not finish within ${codesign_timeout_seconds}s with '$identity_label' (a Keychain dialog with nobody to answer it?)." >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" || status=$?
  return "$status"
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

resolve_identity
if [[ "$identity" != "-" ]] && ! sign_with_timeout "$out_dir/headroom-claude-probe"; then
  # The keychain lists the identity but codesign cannot use it (search list,
  # locked keychain, missing partition grant). Ad-hoc keeps the build usable.
  echo "build-probe.sh: codesign could not use '$identity_label'. Falling back to ad-hoc -- the next Keychain grant will not survive the next rebuild." >&2
  identity="-"
  identity_label="-"
fi
[[ "$identity" == "-" ]] && codesign --force --sign - "$out_dir/headroom-claude-probe"

shasum -a 256 "$out_dir/headroom-claude-probe" | awk '{print $1}' > "$out_dir/SHA256"
printf '%s' "$current_source_hash" > "$out_dir/SOURCE_SHA256"

echo "built $out_dir/headroom-claude-probe (signed: $identity_label)"
echo "sha256 $(cat "$out_dir/SHA256")"
