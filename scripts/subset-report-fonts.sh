#!/usr/bin/env bash
# Regenerates src/browser-report-fonts.ts: Source Serif 4 and Spline Sans Mono
# (both SIL OFL 1.1, texts in licenses/) subset to Basic Latin plus a few
# punctuation and arrow glyphs, as base64 woff2. Needs fonttools and brotli
# (pip install fonttools brotli) and the upstream variable font files:
#   scripts/subset-report-fonts.sh <SourceSerif4-Variable.woff2> <SplineSansMono-Variable.woff2>
# General Sans is deliberately not handled here: it is never bundled.
set -euo pipefail
serif="${1:?path to SourceSerif4-Variable font}"
mono="${2:?path to SplineSansMono-Variable font}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unicodes="U+0020-007E,U+00A0,U+00B0,U+00B7,U+00D7,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+2022,U+2026,U+2191,U+2192,U+2193,U+21BB,U+25CF,U+2248"
fonttools varLib.instancer "$serif" opsz=16 wght=400 -o "$work/serif.ttf" -q
fonttools varLib.instancer "$mono" wght=400:600 -o "$work/mono.ttf" -q
pyftsubset "$work/serif.ttf" --unicodes="$unicodes" --flavor=woff2 --layout-features='kern,liga,tnum,lnum' --output-file="$work/serif.woff2"
pyftsubset "$work/mono.ttf" --unicodes="$unicodes" --flavor=woff2 --layout-features='kern,tnum,zero' --output-file="$work/mono.woff2"
out="$(dirname "$0")/../src/browser-report-fonts.ts"
{
  sed -n '1,/^\/\/ Regenerate/p' "$out"
  printf '\nexport const SOURCE_SERIF_WOFF2_BASE64 = "%s";\n\nexport const SPLINE_MONO_WOFF2_BASE64 = "%s";\n' "$(base64 < "$work/serif.woff2" | tr -d '\n')" "$(base64 < "$work/mono.woff2" | tr -d '\n')"
} > "$out.new"
mv "$out.new" "$out"
