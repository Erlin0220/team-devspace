#!/bin/sh
set -eu
RESOURCES="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"
ROOT="$HOME/Library/Application Support/TeamDevSpace/distribution"
"$RESOURCES/bootstrap.sh" --root "$ROOT" --manifest "$RESOURCES/release-manifest.json" --setup gui || {
  /usr/bin/osascript -e 'display alert "Team DevSpace setup did not complete" message "Your existing Enrollment and project files were retained. Check your Access Key/network, then open Team DevSpace again. For diagnostics, run team-devspace status." as critical' >/dev/null
  exit 1
}
/usr/bin/osascript -e 'display notification "Enrollment and user-login startup are configured. Connect the Team DevSpace workspace app with your Access Key." with title "Team DevSpace"' >/dev/null
