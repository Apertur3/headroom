#!/usr/bin/env bash
# Prints Formula/headroom.rb for the Homebrew tap (Apertur3/homebrew-tap) to
# stdout. Nothing is written to disk and nothing is fetched: the caller already
# has the three facts a formula needs.
#
#   scripts/homebrew-formula.sh <version> <tarball-url> <sha256>
#
# The sha256 must be of the tarball bytes at that URL. The release workflow
# downloads the release asset and hashes it; a human seeding the tap does the
# same by hand (see docs/releasing.md).
set -euo pipefail

die() { printf 'homebrew-formula: %s\n' "$1" >&2; exit 1; }

[ "$#" -eq 3 ] || die "usage: homebrew-formula.sh <version> <tarball-url> <sha256>"

version="$1"
url="$2"
sha256="$3"

# All three arguments end up inside Ruby double-quoted string literals, so each
# is first checked against a closed grammar. No character that could close a
# quote, open a Ruby interpolation or start a comment is in any of these sets,
# so a hostile argument cannot become formula code; it is rejected instead.
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]] ||
  die "version '$version' is not X.Y.Z with an optional dotted prerelease suffix"
[[ "$url" =~ ^https://[A-Za-z0-9._~%@/-]+\.tgz$ ]] ||
  die "tarball url '$url' is not an https URL ending in .tgz"
[[ "$sha256" =~ ^[0-9a-f]{64}$ ]] ||
  die "sha256 '$sha256' is not 64 lowercase hex characters"

# Unquoted heredoc so the three values interpolate. The Ruby below deliberately
# contains no dollar sign and no backtick, so the only substitutions that happen
# are the intended ones; Ruby's own "#{...}" is invisible to the shell.
cat <<FORMULA
class Headroom < Formula
  desc "Live quota, resets and pace states for every AI subscription and account"
  homepage "https://github.com/Apertur3/headroom"
  url "$url"
  version "$version"
  sha256 "$sha256"
  license "MIT"

  depends_on "node"

  # Homebrew repacks the staged package with "npm pack --ignore-scripts", so the
  # package's own prepack hook never runs here and nothing reads the macOS
  # Keychain during installation. The published tarball already carries the
  # compiled JavaScript and the prebuilt Claude probe, which makes this a plain
  # file install on both macOS and Linux; the probe is only ever used on macOS.
  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
    (var/"log/headroom").mkpath
  end

  def caveats
    <<~EOS
      Headroom reads the accounts you already own. One setup pass first:

        headroom accounts discover
        headroom doctor
        brew services start headroom

      On macOS the first read of the Claude Code token asks for Keychain access
      once, and only once:

        headroom keychain grant
    EOS
  end

  service do
    run [opt_bin/"headroom", "daemon"]
    keep_alive true
    log_path var/"log/headroom/headroom.log"
    error_log_path var/"log/headroom/headroom.error.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/headroom version")
  end
end
FORMULA
