#!/bin/sh
# Team DevSpace managed CLI entrypoint.
set -eu
RESOURCES="/Applications/Team DevSpace.app/Contents/Resources"
ROOT="$HOME/Library/Application Support/TeamDevSpace/distribution"
ACTIVE="$ROOT/active-path"

if [ "${1:-}" = "uninstall" ]; then
  "$RESOURCES/bootstrap.sh" --mode uninstall --root "$ROOT"
  # The package-owned app/command/receipt need administrator permission to remove. Enrollment and
  # employee project files are intentionally outside these paths and are retained for repair/revoke.
  /usr/bin/osascript -e 'do shell script "/bin/rm -rf '\''/Applications/Team DevSpace.app'\'' /usr/local/bin/team-devspace; /usr/sbin/pkgutil --forget com.teamdevspace.installer >/dev/null 2>&1 || true" with administrator privileges'
  exit 0
fi

[ -f "$ACTIVE" ] || { echo 'No verified Team DevSpace version is active. Open Team DevSpace to install or repair it.' >&2; exit 1; }
APP=$(sed -n '1p' "$ACTIVE")
case "$APP" in "$ROOT/versions"/*) ;; *) echo 'Invalid active version pointer.' >&2; exit 1 ;; esac
exec "$APP/runtime/bin/node" "$APP/client/cli.mjs" "$@"
