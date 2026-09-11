#!/bin/sh
# Optional local acceptance harness; NOT an employee runtime dependency.
# Root is used only to create disposable mount/PID namespaces. The tested
# installer, Node, MCP and standalone processes always run as the supplied user.
set -eu
if [ "${1:-}" != --inside ]; then
  [ "$(id -u)" -eq 0 ] || { echo 'Run this isolated test helper via WSL -u root; employee installs never need root.' >&2; exit 2; }
  user=$1
  repository=$2
  node=$3
  exec unshare --mount --pid --fork --mount-proc /bin/sh "$0" --inside "$user" "$repository" "$node"
fi
shift
user=$1
repository=$2
node=$3
[ "$(id -u "$user")" -ne 0 ] || { echo 'Tests must use a non-root employee user.' >&2; exit 2; }
[ "$(readlink -f /bin)" = /usr/bin ] || { echo 'This optional helper requires a usr-merged Linux test host.' >&2; exit 2; }
mount --make-rprivate /
scratch=$(mktemp -d /tmp/tds-no-systemd-namespace.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/upper" "$scratch/work"
mount -t overlay overlay -o "lowerdir=/usr/bin,upperdir=$scratch/upper,workdir=$scratch/work" /usr/bin
# Refuse the destructive whiteout unless our disposable overlay really mounted.
[ "$(findmnt -n -o FSTYPE --target /usr/bin)" = overlay ] || exit 2
rm -f /usr/bin/systemctl
mount -t tmpfs -o mode=755 tmpfs /run/systemd
uid=$(id -u "$user")
gid=$(id -g "$user")
cd "$repository"
setpriv --reuid="$uid" --regid="$gid" --init-groups env HOME="$(getent passwd "$user" | cut -d: -f6)" NODE_OPTIONS= \
  "$node" scripts/standalone-smoke.mjs
