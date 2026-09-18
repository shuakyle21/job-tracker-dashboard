#!/usr/bin/env bash
#
# Promote whatever is in staging/ to a new release and point `current` at it.
# Runs on the VPS as the deploy user. Installed at /srv/dashboard/bin/activate.sh
#
#   /srv/dashboard/
#     bin/activate.sh
#     staging/            <- rsync target, overwritten every deploy
#     releases/<ts>-<sha>/
#     current -> releases/<ts>-<sha>
#
# The web server is pointed at current/. Serving from a symlink means a deploy is
# never half-visible: visitors see the old release until the swap, then the new one.

set -euo pipefail

SHA="${1:-manual}"
ROOT="${DASHBOARD_ROOT:-/srv/dashboard}"
KEEP=5

[[ -f "$ROOT/staging/index.html" ]] || { echo "staging/index.html missing — refusing to activate"; exit 1; }

RELEASE="$ROOT/releases/$(date -u +%Y%m%dT%H%M%SZ)-$SHA"
mkdir -p "$RELEASE"
cp -a "$ROOT/staging/." "$RELEASE/"

# ln -sfn is not atomic when the target already exists — it unlinks first, leaving a
# window with no `current` at all. Create a temp link and mv -T over it instead:
# rename(2) is atomic, so there is never a moment without a valid current.
ln -s "$RELEASE" "$ROOT/current.tmp"
mv -Tf "$ROOT/current.tmp" "$ROOT/current"

# Keep the last few releases so a rollback is one symlink move.
#
# Sort by NAME, not mtime. `cp -a` copies staging's timestamps onto the release
# directory, so every release can end up with an identical mtime and `ls -t` then
# tie-breaks alphabetically — which silently prunes the newest releases instead of
# the oldest. Release names are UTC timestamps, so a reverse lexicographic sort is
# both correct and immune to that.
cd "$ROOT/releases"
CURRENT_NAME=$(basename "$(readlink -f "$ROOT/current")")
ls -1d */ 2>/dev/null | sed 's:/$::' | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  # Never delete what is being served, whatever the sort says.
  [[ "$old" == "$CURRENT_NAME" ]] && continue
  rm -rf -- "$old"
done

echo "Activated $(basename "$RELEASE")"
