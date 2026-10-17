#!/bin/sh
# Read the daemon's last quota line without polling a vendor.
{
  for dir in "${CLAUDE_CONFIG_DIR:-}" "$HOME/.claude" "$HOME/.claude2"; do
    [ -n "$dir" ] || continue
    settings="$dir/settings.json"
    if [ -f "$settings" ] && grep -qsF 'hooks/claude-line.sh' "$settings"; then
      exit 0
    fi
  done

  f="${HEADROOM_HOME:-$HOME/.headroom}/line.txt"
  if [ ! -f "$f" ]; then
    if ! command -v headroom >/dev/null 2>&1; then
      printf '%s\n' '[Headroom] plugin needs headroomd: npm install -g headroomd, then headroom setup (https://github.com/Apertur3/headroom#install)'
    fi
    exit 0
  fi
  IFS= read -r line < "$f" || [ -n "$line" ] || exit 0
  [ -n "$line" ] || exit 0
  now=$(date +%s) || exit 0
  case "$(uname -s)" in
    Darwin|*BSD) m=$(stat -f %m "$f") || exit 0 ;;
    *) m=$(stat -c %Y "$f") || exit 0 ;;
  esac
  case "$now$m" in ''|*[!0-9]*) exit 0 ;; esac
  age=$((now - m)); [ "$age" -ge 0 ] || age=0
  printf '%s (as of %ss ago)\n' "$line" "$age"
} 2>/dev/null
exit 0
