#!/usr/bin/env bash
#
# Point `current` at the previous release. Installed at /srv/dashboard/bin/rollback.sh
#
#   ./rollback.sh              -> previous release
#   ./rollback.sh 20260918T060000Z-a1b2c3d   -> that specific one
#   ./rollback.sh --list       -> what is available

set -euo pipefail
ROOT="${DASHBOARD_ROOT:-/srv/dashboard}"
cd "$ROOT/releases"

# Sort by name, not mtime — see the note in activate.sh. Names are UTC timestamps.
list_releases() { ls -1d */ | sed 's:/$::' | sort -r; }

if [[ "${1:-}" == "--list" ]]; then
  CURRENT=$(basename "$(readlink -f "$ROOT/current")")
  list_releases | while read -r r; do
    [[ "$r" == "$CURRENT" ]] && echo "* $r  (current)" || echo "  $r"
  done
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  TARGET="$1"
else
  CURRENT=$(basename "$(readlink -f "$ROOT/current")")
  TARGET=$(list_releases | grep -v "^$CURRENT\$" | head -1)
fi

[[ -d "$ROOT/releases/$TARGET" ]] || { echo "No such release: $TARGET"; exit 1; }
ln -s "$ROOT/releases/$TARGET" "$ROOT/current.tmp"
mv -Tf "$ROOT/current.tmp" "$ROOT/current"
echo "Rolled back to $TARGET"
